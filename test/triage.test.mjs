import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEntry, compileKeywordRe, parseLlmDecisions, buildLlmPrompt, DEFAULT_EXEMPT_KEYWORDS, DEFAULT_PROJECT_KEYWORDS } from "../lib/triage.js";
import { planClusters, buildMergePlan, dice, normTitle } from "../lib/merge.js";

const exemptRe = compileKeywordRe(DEFAULT_EXEMPT_KEYWORDS);
const projectRe = compileKeywordRe(DEFAULT_PROJECT_KEYWORDS);

test("compileKeywordRe matches keywords", () => {
  assert.ok(exemptRe.test("UI风格偏好"));
  assert.ok(projectRe.test("小米登录流程"));
  assert.ok(!exemptRe.test("小米登录流程"));
});

test("classify: global exempt entry stays global", () => {
  const e = { type: "preference", title: "UI风格偏好", content: "圆角", importance: 5 };
  assert.equal(classifyEntry(e, exemptRe, projectRe), "keep-global");
});

test("classify: project keyword entry gets retyped", () => {
  const e = { type: "decision", title: "小米登录流程的必要性", content: "官方登录", importance: 5 };
  assert.equal(classifyEntry(e, exemptRe, projectRe), "retype-project");
});

test("classify: low-importance preference without keyword gets archived", () => {
  const e = { type: "preference", title: "奇怪的小事", content: "x", importance: 2 };
  assert.equal(classifyEntry(e, exemptRe, projectRe), "archive-low");
});

test("classify: mid-importance unknown preference is ambiguous", () => {
  const e = { type: "preference", title: "杂项内容Q7", content: "x", importance: 3 };
  assert.equal(classifyEntry(e, exemptRe, projectRe), "ambiguous");
});

test("classify: decision imp2 without keyword stays ambiguous (no auto archive)", () => {
  const e = { type: "decision", title: "次要安排Q9", content: "x", importance: 2 };
  assert.equal(classifyEntry(e, exemptRe, projectRe), "ambiguous");
});

test("classify: non preference/decision types are untouched", () => {
  const e = { type: "project", title: "小米登录", content: "x", importance: 5 };
  assert.equal(classifyEntry(e, exemptRe, projectRe), "keep-global");
});

test("parseLlmDecisions: tolerant of prose and filters bad actions", () => {
  const raw = '前言 [{"id":"a","action":"keep"},{"id":"b","action":"archive"},{"id":"c","action":"delete"},{"action":"keep"}] 后语';
  assert.deepEqual(parseLlmDecisions(raw), [
    { id: "a", action: "keep" },
    { id: "b", action: "archive" }
  ]);
});

test("parseLlmDecisions: garbage returns empty", () => {
  assert.deepEqual(parseLlmDecisions("没有数组"), []);
  assert.deepEqual(parseLlmDecisions(undefined), []);
});

test("buildLlmPrompt: contains entry ids and caps content", () => {
  const entries = [{ id: "id-1", type: "preference", importance: 3, title: "标题", content: "x".repeat(500) }];
  const { messages } = buildLlmPrompt(entries);
  assert.ok(messages[1].content[0].text.includes("id-1"));
  assert.ok(!messages[1].content[0].text.includes("x".repeat(300)));
});

test("planClusters: near-duplicate titles cluster; unrelated stay apart", () => {
  const bucket = [
    { id: "1", title: "模型偏好", content: "a", importance: 5 },
    { id: "2", title: "AI模型偏好", content: "b", importance: 5 },
    { id: "3", title: "助手需主动联网搜索", content: "c", importance: 5 },
    { id: "4", title: "要求主动联网搜索", content: "c", importance: 5 }
  ];
  const clusters = planClusters(bucket);
  assert.equal(clusters.length, 2);
});

test("planClusters: content containment clusters", () => {
  const bucket = [
    { id: "a", title: "完全不同标题甲", content: "用户喜欢蓝色和白色", importance: 3 },
    { id: "b", title: "完全不同标题乙", content: "喜欢蓝色", importance: 3 }
  ];
  assert.equal(planClusters(bucket).length, 1);
});

test("buildMergePlan: keeper keeps richest, members archived, content capped", () => {
  const group = [
    { id: "k", title: "合并目标", content: "第零句", importance: 3 },
    { id: "m1", title: "合并目标变体", content: "第一句。第二句。第三句。第四句。第五句。第六句。第七句。第八句。", importance: 5 },
    { id: "m2", title: "另一个变体", content: "第一句。", importance: 4 }
  ];
  const { merges, archiveIds } = buildMergePlan([group]);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].keepId, "m1"); // highest importance wins
  assert.equal(merges[0].importance, 5);
  const lines = merges[0].content.split("\n");
  assert.ok(lines.length <= 7, "content capped at maxLines");
  assert.deepEqual(archiveIds.sort(), ["k", "m2"]);
});

test("dice/normTitle: whitespace and punctuation insensitive", () => {
  assert.equal(normTitle("A B-C（D）"), "abcd");
  assert.equal(dice("abc", "abcd"), 0.8);
});
