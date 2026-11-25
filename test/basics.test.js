// 纯函数的单元测试：不需要 Ollama 或 Chroma 在运行。执行：npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitText } from "../src/ingest.js";
import { parseArguments } from "../src/agent.js";
import { formatSources } from "../src/output.js";

test("splitText：短文本只切出一块", () => {
  assert.deepEqual(splitText("  你好，世界  ", 100, 10), ["你好，世界"]);
});

test("splitText：长文本按大小切块，且块之间有重叠", () => {
  const text = "一二三四五六七八九十".repeat(10); // 100 个字符，没有换行
  const chunks = splitText(text, 40, 10);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
  assert.equal(chunks[0].slice(-10), chunks[1].slice(0, 10));
});

test("splitText：尽量在换行处断开", () => {
  const text = `${"a".repeat(30)}\n${"b".repeat(30)}`;
  assert.equal(splitText(text, 40, 5)[0], "a".repeat(30));
});

test("parseArguments：兼容对象、JSON 字符串和非法输入", () => {
  assert.deepEqual(parseArguments({ query: "x" }), { query: "x" });
  assert.deepEqual(parseArguments('{"query":"x"}'), { query: "x" });
  assert.deepEqual(parseArguments("不是 JSON"), {});
  assert.deepEqual(parseArguments(undefined), {});
});

test("formatSources：只有本地来源时不加标签", () => {
  const text = formatSources([{ kind: "local", source: "a.md", chunk: 0, similarity: 0.5 }]);
  assert.equal(text, "\n参考来源：\n  - a.md（片段 1，相似度 0.50）");
});

test("formatSources：混合网络来源时加 [本地] / [网络] 标签", () => {
  const text = formatSources([
    { kind: "local", source: "a.md", chunk: 1, similarity: null },
    { kind: "web", title: "标题", url: "https://example.com" },
  ]);
  assert.match(text, /\[本地\] a\.md（片段 2）/);
  assert.match(text, /\[网络\] 标题 https:\/\/example\.com/);
});
