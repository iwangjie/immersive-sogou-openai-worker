import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTerminology,
  buildYamlTranslationContent,
  extractPayload,
  extractTagValue,
  extractTerminologyEntries,
  normalizeTagSpacing,
  protectTerminology,
  restoreTerminology,
  stripContextEnvelope,
} from "./immersive-sogou-openai-worker.dashboard.js";

test("extractTagValue supports spaced XML-like tags from upstream", () => {
  const input = "< it_text >翻译内容</it_text >";

  assert.equal(extractTagValue(input, "it_text"), "翻译内容");
});

test("extractTagValue supports broken tag names with inner spaces", () => {
  const input = "< it _ text >翻译内容</it _ text >";

  assert.equal(extractTagValue(input, "it_text"), "翻译内容");
});

test("stripContextEnvelope removes translated context tags", () => {
  const input = [
    "< it_ctx_title >《搜索代理技能-按类别和作者筛选| SkillsMP》</it_ctx_title >",
    "< it_text >创建、编辑、改进或审核代理技能。",
    "",
    "%%",
    "",
    "当您需要通过slack工具从OpenClaw控制Slack时使用。</it_text >",
  ].join("\n");

  assert.equal(
    stripContextEnvelope(input),
    ["创建、编辑、改进或审核代理技能。", "", "%%", "", "当您需要通过slack工具从OpenClaw控制Slack时使用。"].join("\n"),
  );
});

test("stripContextEnvelope removes malformed closing it_text tags", () => {
  const input = '来自“ley nos/agent-helper-scripts”</it _ text >';

  assert.equal(stripContextEnvelope(input), '来自“ley nos/agent-helper-scripts”');
});

test("normalizeTagSpacing fixes broken HTML-like tags", () => {
  const input =
    '使用< code>forge setup</code >安装，然后无需输入< code>forge</code >。';

  assert.equal(
    normalizeTagSpacing(input),
    "使用<code>forge setup</code>安装，然后无需输入<code>forge</code>。",
  );
});

test("extractTerminologyEntries parses terms from system prompt", () => {
  const input = [
    "Required Terminology: For terms in `Terms ->`:",
    "Terms -> ",
    "'feat': 'feat', 'Commit': 'Commit'",
  ].join("\n");

  assert.deepEqual(extractTerminologyEntries(input), [
    { source: "feat", target: "feat" },
    { source: "Commit", target: "Commit" },
  ]);
});

test("protectTerminology and restoreTerminology preserve exact terms", () => {
  const terminology = [{ source: "feat", target: "feat" }];
  const protectedResult = protectTerminology(
    "feat: add independent batch proxy pool in {0}",
    terminology,
  );

  assert.equal(
    protectedResult.text,
    "<it_term_0>feat</it_term_0>: add independent batch proxy pool in {0}",
  );
  assert.equal(
    restoreTerminology(
      "< it_term_0 >feat</it_term_0 >: 添加独立批处理代理池于 {0}",
      protectedResult.placeholders,
    ),
    "feat: 添加独立批处理代理池于 {0}",
  );
});

test("applyTerminology enforces source to target mapping on final text", () => {
  assert.equal(
    applyTerminology("feat: 添加独立批处理代理池于 {0}", [
      { source: "feat", target: "feat" },
    ]),
    "feat: 添加独立批处理代理池于 {0}",
  );
});

test("extractPayload supports YAML translation prompts", () => {
  const payload = extractPayload([
    {
      role: "system",
      content:
        'You are a professional, authentic machine translation engine.\n\n## Context Awareness\nDocument Metadata:\nTitle: 《Search Agent Skills - Filter by Category & Author | SkillsMP》',
    },
    {
      role: "user",
      content: [
        "Here is the YAML input:",
        "",
        "<yaml>",
        "- id: 1",
        '  source: from"lev-os/agents"',
        "</yaml>",
        "",
        "Please follow these steps:",
        "",
        '1. Extract the content from the "source" field in the provided YAML object.',
        "",
        "2. Translate the extracted content into Simplified Chinese Language. Place this initial translation into the step1 field.",
        "",
        "3. Refine the initial translation from step1 to make it more natural and understandable in Simplified Chinese Language. Place this refined translation into the step2 field.",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(payload, {
    from: "auto",
    to: "zh-CN",
    items: [
      {
        id: "1",
        source: 'from"lev-os/agents"',
      },
    ],
    outputFormat: "yaml-step-translation",
    terminology: [],
    context: {
      title: "《Search Agent Skills - Filter by Category & Author | SkillsMP》",
      summary: "",
      terms: "",
    },
  });
});

test("buildYamlTranslationContent renders YAML array with step fields", () => {
  assert.equal(
    buildYamlTranslationContent([
      {
        id: "1",
        step1: '来自"lev-os/agents"',
        step2: '来自"lev-os/agents"',
      },
    ]),
    [
      "- id: 1",
      '  step1: 来自"lev-os/agents"',
      '  step2: 来自"lev-os/agents"',
    ].join("\n"),
  );
});

test("buildYamlTranslationContent quotes only unsafe YAML scalars", () => {
  assert.equal(
    buildYamlTranslationContent([
      {
        id: "1",
        step1: "400: Unable to extract payload",
        step2: "true",
      },
    ]),
    [
      "- id: 1",
      "  step1: '400: Unable to extract payload'",
      "  step2: 'true'",
    ].join("\n"),
  );
});

test("extractPayload keeps terminology from default system prompt", () => {
  const payload = extractPayload([
    {
      role: "system",
      content: [
        "你是一个专业的简体中文母语译者，需将文本流畅地翻译为简体中文。",
        "",
        "Required Terminology: For terms in `Terms ->`:",
        "Terms -> ",
        "'feat': 'feat'",
      ].join("\n"),
    },
    {
      role: "user",
      content: "翻译为简体中文（仅输出译文内容）：\n\nfeat: add independent batch proxy pool by @kamill7779 in {0}",
    },
  ]);

  assert.deepEqual(payload?.terminology, [
    { source: "feat", target: "feat" },
  ]);
  assert.equal(payload?.context.terms, "'feat': 'feat'");
});
