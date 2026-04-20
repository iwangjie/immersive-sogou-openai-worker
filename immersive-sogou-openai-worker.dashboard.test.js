import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTagValue,
  stripContextEnvelope,
} from "./immersive-sogou-openai-worker.dashboard.js";

test("extractTagValue supports spaced XML-like tags from upstream", () => {
  const input = "< it_text >翻译内容</it_text >";

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
