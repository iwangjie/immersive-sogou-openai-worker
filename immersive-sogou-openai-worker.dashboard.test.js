import assert from "node:assert/strict";
import test from "node:test";

import {
  buildYamlTranslationContent,
  extractPayload,
  extractTagValue,
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
