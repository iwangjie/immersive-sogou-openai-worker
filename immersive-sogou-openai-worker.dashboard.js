/**
 * Cloudflare Worker: OpenAI-compatible chat/completions wrapper for
 * https://fanyi.sogou.com/api/transpc/hunyuan/translate
 *
 * Dashboard deployment:
 * 1. Cloudflare Dashboard -> Workers & Pages -> Create Worker
 * 2. Paste this file into the editor
 * 3. Settings -> Variables:
 *    - AUTH_TOKEN   Optional. If set, clients must send:
 *      Authorization: Bearer <AUTH_TOKEN>
 *    - CONTEXT_MODE Optional. "on" by default. Set "off" to disable context wrapping.
 *
 * Immersive Translate suggested settings:
 * - Base URL: https://your-worker.workers.dev/v1
 * - API Key:  same as AUTH_TOKEN
 * - Model:    sogou-hunyuan-translate
 *
 * Prompt template example:
 *
 * systemPrompt:
 * You are a translation adapter.
 * You must output only the translated content of the TEXT block.
 * Do not explain anything.
 * Do not return TITLE, SUMMARY, TERMS, XML tags, or any wrapper text.
 * Preserve paragraph count, placeholder tags, Markdown, and %% separators.
 *
 * prompt / multiplePrompt / subtitlePrompt:
 * <IMMERSIVE_PAYLOAD>
 * <FROM>{{from}}</FROM>
 * <TO>{{to}}</TO>
 * <TITLE>{{title_prompt}}</TITLE>
 * <SUMMARY>{{summary_prompt}}</SUMMARY>
 * <TERMS>{{terms_prompt}}</TERMS>
 * <TEXT>{{text}}</TEXT>
 * </IMMERSIVE_PAYLOAD>
 */

const SOGOU_API_URL =
  "https://fanyi.sogou.com/api/transpc/hunyuan/translate";
const MODEL_ID = "sogou-hunyuan-translate";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

const LANG_MAP = {
  zh: "zh-CHS",
  "zh-CN": "zh-CHS",
  "zh-Hans": "zh-CHS",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders,
    },
  });
}

function textResponse(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers,
  });
}

function normalizeLang(lang) {
  if (!lang) return null;
  if (lang === "auto") return "auto";
  if (lang === "zh-TW" || lang === "zh-Hant" || lang === "zh-CHT") {
    return null;
  }
  return LANG_MAP[lang] || lang;
}

function restoreLang(lang) {
  return lang === "zh-CHS" ? "zh-CN" : lang;
}

function detectLang(text) {
  const japaneseCount = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const koreanCount = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  if (japaneseCount > 0 && japaneseCount >= koreanCount) return "ja";
  if (koreanCount > 0 && koreanCount > japaneseCount) return "ko";
  if (chineseCount > 0 && chineseCount * 2 >= latinCount) return "zh-CHS";
  return "en";
}

function getContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTagNamePattern(tagName) {
  return tagName
    .split("")
    .map((char) => escapeRegExp(char))
    .join("\\s*");
}

function buildTagPattern(tagName, captureInnerText = true, global = false) {
  const tagNamePattern = buildTagNamePattern(tagName);
  const innerPattern = captureInnerText ? "([\\s\\S]*?)" : "[\\s\\S]*?";
  return new RegExp(
    `<\\s*${tagNamePattern}\\s*>${innerPattern}<\\s*\\/\\s*${tagNamePattern}\\s*>`,
    global ? "gi" : "i",
  );
}

function extractTagValue(input, tagName) {
  const pattern = buildTagPattern(tagName);
  const match = input.match(pattern);
  return match ? match[1].trim() : "";
}

function extractTaggedPayload(messages) {
  const combined = messages
    .map((message) => getContentText(message.content))
    .filter(Boolean)
    .join("\n\n");

  const payload = extractTagValue(combined, "IMMERSIVE_PAYLOAD") || combined;
  const text = extractTagValue(payload, "TEXT");
  const to = extractTagValue(payload, "TO");
  const from = extractTagValue(payload, "FROM") || "auto";
  const title = extractTagValue(payload, "TITLE");
  const summary = extractTagValue(payload, "SUMMARY");
  const terms = extractTagValue(payload, "TERMS");

  return {
    from,
    to,
    text,
    context: {
      title,
      summary,
      terms,
    },
  };
}

function extractTitleFromText(input) {
  const patterns = [
    /(?:^|\n)Title:\s*([^\n]+)/i,
    /(?:^|\n)标题[：:]\s*([^\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1].trim();
  }

  return "";
}

function extractTermsSection(input) {
  if (!input) return "";

  const matches = [...input.matchAll(/(?:^|\n)Terms\s*->\s*/gi)];
  const lastMatch = matches.at(-1);
  if (!lastMatch || typeof lastMatch.index !== "number") {
    return "";
  }

  return input.slice(lastMatch.index + lastMatch[0].length).trim();
}

function extractTerminologyEntries(input) {
  const termsSection = extractTermsSection(input);
  if (!termsSection) return [];

  const entries = [];
  const pattern =
    /(['"])((?:\\.|(?!\1)[\s\S])*?)\1\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*?)\3/g;

  for (const match of termsSection.matchAll(pattern)) {
    const source = match[2].replace(/\\(['"])/g, "$1").trim();
    const target = match[4].replace(/\\(['"])/g, "$1").trim();

    if (!source) continue;

    entries.push({ source, target: target || source });
  }

  return entries;
}

function mapLanguageLabelToCode(label) {
  if (!label) return null;

  const value = label.trim().toLowerCase();
  const mappings = [
    {
      pattern:
        /^(简体中文|简中|中文简体|simplified chinese|chinese simplified)( language)?$/,
      code: "zh-CN",
    },
    { pattern: /^(中文|汉语|中文简体版)$/, code: "zh-CN" },
    {
      pattern:
        /^(繁体中文|繁中|traditional chinese|chinese traditional)( language)?$/,
      code: "zh-TW",
    },
    { pattern: /^(英语|英文|english)( language)?$/, code: "en" },
    { pattern: /^(日语|日文|japanese)( language)?$/, code: "ja" },
    { pattern: /^(韩语|韩文|korean)( language)?$/, code: "ko" },
  ];

  for (const item of mappings) {
    if (item.pattern.test(value)) return item.code;
  }

  return null;
}

function extractTargetLangFromText(input) {
  const patterns = [
    /翻译为\s*([^\n（(:：]+)\s*(?:（[^）]*）|\([^)]*\))?\s*[:：]/i,
    /translate\s+to\s+([^\n(:：]+)\s*(?:\([^)]*\))?\s*[:：]/i,
    /翻译成\s*([^\n（(:：]+)\s*(?:（[^）]*）|\([^)]*\))?\s*[:：]/i,
    /translate[\s\S]*?\binto\s+([a-z\u4e00-\u9fff -]+?)(?:\s+language)?(?:[.\n]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (!match) continue;

    const langCode = mapLanguageLabelToCode(match[1]);
    if (langCode) return langCode;
  }

  return null;
}

function extractTextFromUserPrompt(input) {
  const normalized = input.replace(/\r\n/g, "\n");
  const separators = ["\n\n", "：\n", ":\n"];

  for (const separator of separators) {
    const index = normalized.indexOf(separator);
    if (index >= 0) {
      const value = normalized.slice(index + separator.length).trim();
      if (value) return value;
    }
  }

  const colonIndex = normalized.search(/[:：]/);
  if (colonIndex >= 0) {
    const value = normalized.slice(colonIndex + 1).trim();
    if (value) return value;
  }

  return normalized.trim();
}

function parseYamlScalar(rawValue) {
  const value = rawValue.trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function extractYamlTranslationItems(input) {
  const yamlText = extractTagValue(input, "yaml");
  if (!yamlText) return [];

  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const items = [];
  let currentItem = null;

  for (const line of lines) {
    const idMatch = line.match(/^\s*-\s*id\s*:\s*(.+?)\s*$/);
    if (idMatch) {
      if (currentItem?.id && currentItem?.source) {
        items.push(currentItem);
      }

      currentItem = {
        id: parseYamlScalar(idMatch[1]),
        source: "",
      };
      continue;
    }

    if (!currentItem) continue;

    const sourceMatch = line.match(/^\s+source\s*:\s*(.+?)\s*$/);
    if (sourceMatch) {
      currentItem.source = parseYamlScalar(sourceMatch[1]);
    }
  }

  if (currentItem?.id && currentItem?.source) {
    items.push(currentItem);
  }

  return items;
}

function extractPayloadFromYamlMessages(messages) {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => getContentText(message.content))
    .filter(Boolean)
    .join("\n\n");

  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => getContentText(message.content))
    .filter(Boolean)
    .join("\n\n");

  if (!userText) return null;

  const items = extractYamlTranslationItems(userText);
  const targetLang =
    extractTargetLangFromText(userText) || extractTargetLangFromText(systemText);

  if (items.length === 0 || !targetLang) {
    return null;
  }

  return {
    from: "auto",
    to: targetLang,
    items,
    outputFormat: "yaml-step-translation",
    terminology: extractTerminologyEntries(systemText),
    context: {
      title: extractTitleFromText(systemText),
      summary: "",
      terms: extractTermsSection(systemText),
    },
  };
}

function extractPayloadFromDefaultMessages(messages) {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => getContentText(message.content))
    .filter(Boolean)
    .join("\n\n");

  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => getContentText(message.content))
    .filter(Boolean)
    .join("\n\n");

  if (!userText) return null;

  const targetLang =
    extractTargetLangFromText(userText) || extractTargetLangFromText(systemText);
  const text = extractTextFromUserPrompt(userText);

  if (!targetLang || !text) return null;

  return {
    from: "auto",
    to: targetLang,
    text,
    terminology: extractTerminologyEntries(systemText),
    context: {
      title: extractTitleFromText(systemText),
      summary: "",
      terms: extractTermsSection(systemText),
    },
  };
}

function extractPayload(messages) {
  const taggedPayload = extractTaggedPayload(messages);
  if (taggedPayload.text && taggedPayload.to) {
    return taggedPayload;
  }

  const yamlPayload = extractPayloadFromYamlMessages(messages);
  if (yamlPayload) {
    return yamlPayload;
  }

  return extractPayloadFromDefaultMessages(messages);
}

function buildContextEnvelope(text, context) {
  const chunks = [];

  if (context.title) {
    chunks.push(`<it_ctx_title>${context.title}</it_ctx_title>`);
  }
  if (context.summary) {
    chunks.push(`<it_ctx_summary>${context.summary}</it_ctx_summary>`);
  }
  if (context.terms) {
    chunks.push(`<it_ctx_terms>${context.terms}</it_ctx_terms>`);
  }

  if (chunks.length === 0) return text;

  return `${chunks.join("\n")}\n<it_text>${text}</it_text>`;
}

function stripContextEnvelope(translatedText) {
  const extractedText = extractTagValue(translatedText, "it_text");
  if (extractedText) return extractedText;

  const itTextTagPattern = new RegExp(
    `<\\s*\\/?\\s*${buildTagNamePattern("it_text")}\\s*>`,
    "gi",
  );

  return ["it_ctx_title", "it_ctx_summary", "it_ctx_terms"]
    .reduce(
      (text, tagName) => text.replace(buildTagPattern(tagName, false), ""),
      translatedText,
    )
    .replace(itTextTagPattern, "")
    .trim();
}

function normalizeTagSpacing(text) {
  return text.replace(
    /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?\s*(\/?)>/g,
    (_, closingSlash, tagName, rawAttributes = "", selfClosingSlash) => {
      const attributes = rawAttributes.trim();
      const serializedAttributes = attributes ? ` ${attributes}` : "";
      const serializedSelfClosing = selfClosingSlash ? " /" : "";

      return `<${closingSlash}${tagName}${serializedAttributes}${serializedSelfClosing}>`;
    },
  );
}

function buildTermBoundaryPattern(term) {
  const escapedTerm = escapeRegExp(term);
  const startsWithWordChar = /^[A-Za-z0-9_]/.test(term);
  const endsWithWordChar = /[A-Za-z0-9_]$/.test(term);
  const prefix = startsWithWordChar ? "(?<![A-Za-z0-9_])" : "";
  const suffix = endsWithWordChar ? "(?![A-Za-z0-9_])" : "";

  return new RegExp(`${prefix}${escapedTerm}${suffix}`, "g");
}

function buildTerminologyTagName(index) {
  return `it_term_${index}`;
}

function protectTerminology(text, terminology) {
  if (!Array.isArray(terminology) || terminology.length === 0) {
    return { text, placeholders: [] };
  }

  const placeholders = [];
  let protectedText = text;
  const sortedTerminology = [...terminology].sort(
    (left, right) => right.source.length - left.source.length,
  );

  for (const entry of sortedTerminology) {
    const pattern = buildTermBoundaryPattern(entry.source);
    const tagName = buildTerminologyTagName(placeholders.length);

    if (!pattern.test(protectedText)) {
      continue;
    }

    pattern.lastIndex = 0;
    protectedText = protectedText.replace(
      pattern,
      `<${tagName}>${entry.source}</${tagName}>`,
    );
    placeholders.push({
      tagName,
      source: entry.source,
      target: entry.target || entry.source,
    });
  }

  return {
    text: protectedText,
    placeholders,
  };
}

function restoreTerminology(text, placeholders) {
  return placeholders.reduce(
    (value, item) =>
      value.replace(buildTagPattern(item.tagName, false, true), item.target),
    text,
  );
}

function applyTerminology(text, terminology) {
  if (!Array.isArray(terminology) || terminology.length === 0) {
    return text;
  }

  return [...terminology]
    .sort((left, right) => right.source.length - left.source.length)
    .reduce((value, entry) => {
      const pattern = buildTermBoundaryPattern(entry.source);
      return value.replace(pattern, entry.target || entry.source);
    }, text);
}

function buildChatCompletion(model, content, created) {
  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildStreamResponse(model, content, created) {
  const encoder = new TextEncoder();
  const id = `chatcmpl_${crypto.randomUUID()}`;

  const stream = new ReadableStream({
    start(controller) {
      const events = [
        {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        },
        {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: null,
            },
          ],
        },
        {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        },
      ];

      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function formatYamlValue(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return value;
  }

  const stringValue = String(value);
  const reservedWords = new Set([
    "",
    "null",
    "true",
    "false",
    "yes",
    "no",
    "on",
    "off",
    "~",
  ]);
  const lowerValue = stringValue.toLowerCase();
  const shouldQuote =
    reservedWords.has(lowerValue) ||
    /\r|\n/.test(stringValue) ||
    /^\s|\s$/.test(stringValue) ||
    /^[\-[\]{}#&*!|>'"%@`,]/.test(stringValue) ||
    /:\s/.test(stringValue);

  if (!shouldQuote) {
    return stringValue;
  }

  return `'${stringValue.replace(/'/g, "''")}'`;
}

function buildYamlTranslationContent(items) {
  return items
    .map(
      (item) =>
        `- id: ${formatYamlValue(item.id)}\n  step1: ${formatYamlValue(item.step1)}\n  step2: ${formatYamlValue(item.step2)}`,
    )
    .join("\n");
}

function isAuthorized(request, env) {
  const expectedToken = env.AUTH_TOKEN;
  if (!expectedToken) return true;

  const bearerToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");

  return bearerToken === expectedToken;
}

function isModelsPath(pathname) {
  return pathname === "/v1/models" || pathname === "/models";
}

function isChatCompletionsPath(pathname) {
  return pathname === "/v1/chat/completions" || pathname === "/chat/completions";
}

async function translateOne(text, sourceLang, targetLang) {
  const response = await fetch(SOGOU_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify({
      text,
      from_lang: sourceLang,
      to_lang: targetLang,
    }),
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data?.status !== 0 || data?.data?.code !== 0) {
    throw new Error(data?.data?.message || "Sogou translation failed");
  }

  return {
    detectedSourceLang: restoreLang(data?.data?.from_lang || sourceLang),
    translatedText: data?.data?.content || "",
  };
}

async function translateText(
  text,
  sourceLangInput,
  targetLang,
  includeContext,
  context,
  terminology = [],
) {
  const { text: protectedText, placeholders } = protectTerminology(
    text,
    terminology,
  );
  const sourceLang =
    sourceLangInput === "auto" ? detectLang(protectedText) : sourceLangInput;
  if (sourceLang === targetLang) {
    return applyTerminology(
      normalizeTagSpacing(restoreTerminology(protectedText, placeholders)),
      terminology,
    );
  }

  const upstreamText = includeContext
    ? buildContextEnvelope(protectedText, context)
    : protectedText;
  const result = await translateOne(upstreamText, sourceLang, targetLang);
  const translatedText = includeContext
    ? stripContextEnvelope(result.translatedText)
    : result.translatedText;

  return applyTerminology(
    normalizeTagSpacing(restoreTerminology(translatedText, placeholders)),
    terminology,
  );
}

async function handleChatCompletions(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Request body must be valid JSON" } }, 400);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) {
    return json({ error: { message: "messages must be a non-empty array" } }, 400);
  }

  const payload = extractPayload(messages);
  const hasTextPayload = Boolean(payload?.text);
  const hasYamlPayload =
    payload?.outputFormat === "yaml-step-translation" &&
    Array.isArray(payload?.items) &&
    payload.items.length > 0;

  if ((!hasTextPayload && !hasYamlPayload) || !payload?.to) {
    return json(
      {
        error: {
          message:
            "Unable to extract payload. Supported formats: tagged prompt with <IMMERSIVE_PAYLOAD> or default translation prompt like '翻译为简体中文：...'",
        },
      },
      400,
    );
  }

  const targetLang = normalizeLang(payload.to);
  const sourceLangInput = normalizeLang(payload.from);

  if (!targetLang) {
    return json(
      { error: { message: `Unsupported target language: ${payload.to}` } },
      400,
    );
  }

  if (sourceLangInput !== "auto" && !sourceLangInput) {
    return json(
      { error: { message: `Unsupported source language: ${payload.from}` } },
      400,
    );
  }

  const includeContext = env.CONTEXT_MODE !== "off";

  try {
    const model = body?.model || MODEL_ID;
    const created = Math.floor(Date.now() / 1000);
    let translatedContent = "";

    if (payload.outputFormat === "yaml-step-translation") {
      const translatedItems = [];

      for (const item of payload.items) {
        const translatedText = await translateText(
          item.source,
          sourceLangInput,
          targetLang,
          includeContext,
          payload.context,
          payload.terminology,
        );

        translatedItems.push({
          id: item.id,
          step1: translatedText,
          step2: translatedText,
        });
      }

      translatedContent = buildYamlTranslationContent(translatedItems);
    } else {
      translatedContent = await translateText(
        payload.text,
        sourceLangInput,
        targetLang,
        includeContext,
        payload.context,
        payload.terminology,
      );
    }

    if (body?.stream === true) {
      return buildStreamResponse(model, translatedContent, created);
    }

    return json(buildChatCompletion(model, translatedContent, created));
  } catch (error) {
    return json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Unknown upstream error",
        },
      },
      502,
    );
  }
}

function handleHome(env) {
  const authEnabled = Boolean(env.AUTH_TOKEN);
  const lines = [
    "immersive-sogou-openai-worker",
    "",
    "Endpoints:",
    "  GET  /",
    "  GET  /v1/models",
    "  GET  /models",
    "  POST /v1/chat/completions",
    "  POST /chat/completions",
    "",
    `Auth: ${authEnabled ? "Bearer token required" : "disabled"}`,
    `Context mode: ${env.CONTEXT_MODE || "on"}`,
    "",
    "Suggested Immersive Translate settings:",
    "  Base URL: https://your-worker.workers.dev/v1",
    "  API Key:  same as AUTH_TOKEN",
    `  Model:    ${MODEL_ID}`,
  ];

  return textResponse(lines.join("\n"), {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return handleHome(env);
    }

    if (!isAuthorized(request, env)) {
      return json(
        { error: { message: "Unauthorized" } },
        401,
        { "www-authenticate": 'Bearer realm="immersive-sogou-openai-worker"' },
      );
    }

    if (request.method === "GET" && isModelsPath(url.pathname)) {
      return json({
        object: "list",
        data: [
          {
            id: MODEL_ID,
            object: "model",
            owned_by: "custom-worker",
          },
        ],
      });
    }

    if (request.method === "POST" && isChatCompletionsPath(url.pathname)) {
      return handleChatCompletions(request, env);
    }

    return json({ error: { message: "Not found" } }, 404);
  },
};

export {
  applyTerminology,
  buildYamlTranslationContent,
  extractPayload,
  extractTagValue,
  extractTerminologyEntries,
  normalizeTagSpacing,
  protectTerminology,
  restoreTerminology,
  stripContextEnvelope,
};
