// 纯函数的单元测试：不需要 Ollama 或 Chroma 在运行。执行：npm test
// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, projectRoot } from "../src/core/config.js";
import { splitText, chunkFile } from "../src/core/ingest.js";
import { hasModel } from "../src/core/ollama.js";
import { normalizeResults } from "../src/core/websearch.js";
import { formatSources, createPrinter, formatChecks } from "../src/cli/output.js";
import { memoryOut } from "./helpers.js";

test("loadConfig：没有任何环境变量时使用默认值且没有错误", () => {
  const { config, errors } = loadConfig({});
  assert.deepEqual(errors, []);
  assert.equal(config.topK, 4);
  assert.equal(config.webSearch, false);
  assert.equal(config.docsDir, path.join(projectRoot, "docs"));
});

test("loadConfig：CHUNK_OVERLAP 允许为 0，数值会去掉首尾空格", () => {
  const { config, errors } = loadConfig({ CHUNK_OVERLAP: "0", TOP_K: " 6 " });
  assert.deepEqual(errors, []);
  assert.equal(config.chunkOverlap, 0);
  assert.equal(config.topK, 6);
});

test("loadConfig：非法值回退默认值并收集所有错误，而不是抛异常", () => {
  const { config, errors } = loadConfig({
    TOP_K: "abc",
    SHOW_THINKING: "maybe",
    MIN_SIMILARITY: "2",
    WEB_SEARCH: "true",
    CHUNK_SIZE: "100",
    CHUNK_OVERLAP: "80",
  });
  assert.equal(config.topK, 4);
  assert.equal(errors.length, 5);
  assert.ok(errors.some((e) => e.includes("TAVILY_API_KEY")));
  assert.ok(errors.some((e) => e.includes("CHUNK_OVERLAP")));
});

test("loadConfig：DOCS_DIR 相对路径以项目根目录为基准", () => {
  assert.equal(loadConfig({ DOCS_DIR: "my-notes" }).config.docsDir, path.join(projectRoot, "my-notes"));
  assert.equal(loadConfig({ DOCS_DIR: "/tmp/kb" }).config.docsDir, "/tmp/kb");
});

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

test("chunkFile：给每个片段带上来源与序号", () => {
  const chunks = chunkFile("notes/a.md", "第一段");
  assert.deepEqual(chunks, [{ source: "notes/a.md", chunk: 0, text: "第一段" }]);
});

test("hasModel：忽略 :latest 后缀", () => {
  assert.ok(hasModel(["bge-m3:latest"], "bge-m3"));
  assert.ok(hasModel(["bge-m3"], "bge-m3:latest"));
  assert.ok(!hasModel(["qwen3.5:4b"], "qwen3.5:9b"));
});

test("normalizeResults：过滤非 http 链接与残缺条目，按 URL 去重，压缩空白", () => {
  const results = normalizeResults([
    { url: "https://a.com", title: " A ", content: "x\n\n y" },
    { url: "https://a.com", title: "重复", content: "z" },
    { url: "javascript:alert(1)", title: "坏链接", content: "z" },
    { url: "https://b.com", title: "", content: "没标题" },
    null,
  ]);
  assert.deepEqual(results, [{ kind: "web", title: "A", url: "https://a.com", snippet: "x y" }]);
  assert.deepEqual(normalizeResults("不是数组"), []);
});

test("formatSources：只有本地来源时不加标签", () => {
  const text = formatSources([{ kind: "local", source: "a.md", chunk: 0, text: "", similarity: 0.5 }]);
  assert.equal(text, "\n参考来源：\n  - a.md（片段 1，相似度 0.50）");
});

test("formatSources：混合网络来源时加 [本地] / [网络] 标签", () => {
  const text = formatSources([
    { kind: "local", source: "a.md", chunk: 1, text: "", similarity: null },
    { kind: "web", title: "标题", url: "https://example.com", snippet: "" },
  ]);
  assert.match(text, /\[本地\] a\.md（片段 2）/);
  assert.match(text, /\[网络\] 标题 https:\/\/example\.com/);
});

test("createPrinter：思考过程走 thinkingOut，回答与来源走 answerOut", () => {
  const answerOut = memoryOut();
  const thinkingOut = memoryOut();
  const printer = createPrinter({ showThinking: true, answerOut, thinkingOut, answerPrefix: "助手 > " });
  printer.onDelta({ type: "thinking", text: "想\n一下", round: 0 });
  printer.onDelta({ type: "content", text: "答案", round: 0 });
  printer.finish({ answer: "答案", sources: [] });
  assert.equal(thinkingOut.text, "\n思考过程：\n  想\n  一下\n");
  assert.equal(answerOut.text, "助手 > 答案\n");
});

test("createPrinter：关闭思考过程时丢弃 thinking；不同轮的 content 空一行", () => {
  const out = memoryOut();
  const printer = createPrinter({ showThinking: false, answerOut: out });
  printer.onDelta({ type: "thinking", text: "不显示", round: 0 });
  printer.onDelta({ type: "content", text: "先查一下。", round: 0 });
  printer.onDelta({ type: "content", text: "答案。", round: 1 });
  printer.finish({ answer: "", sources: [] });
  assert.equal(out.text, "先查一下。\n\n答案。\n");
});

test("createPrinter：模型没有流式输出 content 时，finish 兜底打印完整答案", () => {
  const out = memoryOut();
  const printer = createPrinter({ showThinking: false, answerOut: out });
  printer.onDelta({ type: "notice", text: "🌐 提示" });
  printer.finish({ answer: "兜底答案", sources: [] });
  assert.equal(out.text, "🌐 提示\n兜底答案\n");
});

test("formatChecks：失败项附带多行提示", () => {
  const text = formatChecks([
    { ok: true, label: "通过" },
    { ok: false, label: "失败", hint: "第一行\n第二行" },
  ]);
  assert.equal(text, "✅ 通过\n❌ 失败\n   → 第一行\n   → 第二行");
});
