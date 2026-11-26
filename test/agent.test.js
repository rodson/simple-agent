// Agent 循环的行为测试：用假模型、假检索替换 Ollama / Chroma / Tavily，不需要任何服务在运行
// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, cleanRewrite, createAgent, parseArguments } from "../src/core/agent.js";
import { loadConfig } from "../src/core/config.js";
import { fakeChat, toolCall } from "./helpers.js";

const baseConfig = loadConfig({ MAX_TOOL_ROUNDS: "2", MIN_SIMILARITY: "0.5" }).config;
const webConfig = loadConfig({
  MAX_TOOL_ROUNDS: "2",
  MIN_SIMILARITY: "0.5",
  WEB_SEARCH: "true",
  TAVILY_API_KEY: "k",
}).config;

const hit = (source = "a.md", similarity = 0.8, chunk = 0) => ({ source, chunk, text: `${source} 的内容`, similarity });

/** @param {any[][]} batches 每次检索依次返回的结果 */
function fakeSearch(batches) {
  /** @type {string[]} */
  const queries = [];
  /** @param {string} text */
  const searchLocal = async (text) => {
    queries.push(text);
    return batches[Math.min(queries.length - 1, batches.length - 1)];
  };
  return { searchLocal, queries };
}

test("parseArguments：兼容对象、JSON 字符串和非法输入", () => {
  assert.deepEqual(parseArguments({ query: "x" }), { query: "x" });
  assert.deepEqual(parseArguments('{"query":"x"}'), { query: "x" });
  assert.deepEqual(parseArguments("不是 JSON"), {});
  assert.deepEqual(parseArguments("123"), {});
  assert.deepEqual(parseArguments(undefined), {});
});

test("第一步总是由 Agent 自己检索知识库，结果以 tool 消息交给模型", async () => {
  const { chat, calls } = fakeChat([{ content: "答案 [来源: a.md]" }]);
  const { searchLocal, queries } = fakeSearch([[hit()]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");

  assert.deepEqual(queries, ["问题"]);
  assert.equal(result.answer, "答案 [来源: a.md]");
  assert.deepEqual(
    result.sources.map((s) => s.kind === "local" && s.source),
    ["a.md"],
  );
  const roles = calls[0].messages.map((/** @type {any} */ m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool"]);
  assert.equal(calls[0].messages[2].tool_calls[0].function.name, "search_knowledge_base");
});

test("知识库为空且未开联网：直接短路，不调用模型", async () => {
  const { chat, calls } = fakeChat([{ content: "不该出现" }]);
  const { searchLocal } = fakeSearch([[]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.equal(calls.length, 0);
  assert.match(result.answer, /知识库中没有相关信息/);
  assert.deepEqual(result.sources, []);
});

test("知识库为空且开了联网：用问题原文兜底搜一次网络", async () => {
  const { chat, calls } = fakeChat([{ content: "网络答案" }]);
  const { searchLocal } = fakeSearch([[]]);
  /** @type {string[]} */
  const webQueries = [];
  /** @param {string} q */
  const searchWeb = async (q) => {
    webQueries.push(q);
    return {
      results: [{ kind: /** @type {const} */ ("web"), title: "T", url: "https://x.com", snippet: "S" }],
      error: null,
    };
  };
  const result = await createAgent({ config: webConfig, chat, searchLocal, searchWeb }).answer("最新版本？");
  assert.deepEqual(webQueries, ["最新版本？"]);
  assert.equal(calls.length, 1);
  assert.equal(result.answer, "网络答案");
  assert.equal(result.sources[0].kind, "web");
});

test("低于 MIN_SIMILARITY 的片段不交给模型，也不列为来源", async () => {
  const { chat, calls } = fakeChat([{ content: "知识库中没有相关信息" }]);
  const { searchLocal } = fakeSearch([[hit("low.md", 0.3)]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.deepEqual(result.sources, []);
  const toolResult = JSON.parse(calls[0].messages.at(-1).content);
  assert.deepEqual(toolResult.results, []);
  assert.ok(toolResult.note);
});

test("模型可以换关键词追加检索，来源去重合并", async () => {
  const { chat } = fakeChat([
    { tool_calls: [toolCall("search_knowledge_base", '{"query":"换个词"}')] },
    { content: "答" },
  ]);
  const { searchLocal, queries } = fakeSearch([[hit("a.md")], [hit("a.md"), hit("b.md")]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.deepEqual(queries, ["问题", "换个词"]);
  assert.deepEqual(
    result.sources.map((s) => s.kind === "local" && s.source),
    ["a.md", "b.md"],
  );
});

test("达到 MAX_TOOL_ROUNDS 后最后一轮不提供工具，并要求直接回答", async () => {
  const { chat, calls } = fakeChat([
    { tool_calls: [toolCall("search_knowledge_base", { query: "x" })] },
    { tool_calls: [toolCall("search_knowledge_base", { query: "y" })] },
    { content: "最终答案" },
  ]);
  const { searchLocal } = fakeSearch([[hit()]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.equal(calls.length, 3);
  assert.ok(calls[0].tools && calls[1].tools);
  assert.equal(calls[2].tools, undefined);
  assert.match(calls[2].messages.at(-1).content, /不要再调用工具/);
  assert.equal(result.answer, "最终答案");
});

test("模型发起的工具调用出错时，错误交还给模型，回答继续", async () => {
  const { chat, calls } = fakeChat([
    { tool_calls: [toolCall("search_knowledge_base", { query: "x" })] },
    { content: "答" },
  ]);
  let n = 0;
  const searchLocal = async () => {
    if (++n === 2) throw new Error("Chroma 超时\n请另开一个终端");
    return [hit()];
  };
  /** @type {any[]} */
  const events = [];
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题", {
    onDelta: (e) => events.push(e),
  });
  assert.equal(result.answer, "答");
  assert.deepEqual(JSON.parse(calls[1].messages.at(-1).content), { error: "工具执行失败：Chroma 超时" });
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("Chroma 超时")));
});

test("Agent 自己发起的第一次检索出错时直接抛出（例如 Chroma 没启动）", async () => {
  const { chat } = fakeChat([{ content: "答" }]);
  const searchLocal = async () => {
    throw new Error("无法连接 Chroma");
  };
  await assert.rejects(createAgent({ config: baseConfig, chat, searchLocal }).answer("问题"), /无法连接 Chroma/);
});

test("联网每题最多 1 次，且忽略模型给的参数、只发送问题原文", async () => {
  const { chat, calls } = fakeChat([
    { tool_calls: [toolCall("search_web", { query: "知识库片段被拼进来" })] },
    { tool_calls: [toolCall("search_web", {})] },
    { content: "答" },
  ]);
  const { searchLocal } = fakeSearch([[hit()]]);
  /** @type {string[]} */
  const webQueries = [];
  /** @param {string} q */
  const searchWeb = async (q) => {
    webQueries.push(q);
    return { results: [], error: null };
  };
  await createAgent({ config: webConfig, chat, searchLocal, searchWeb }).answer("原始问题");
  assert.deepEqual(webQueries, ["原始问题"]);
  assert.match(calls[2].messages.at(-2).content, /次数已用完/); // 最后一条是收尾提示
});

test("各轮 content 拼接成最终答案，与屏幕上看到的一致", async () => {
  const { chat } = fakeChat([
    { content: "我再查一下。", tool_calls: [toolCall("search_knowledge_base", { query: "x" })] },
    { content: "答案是 42。" },
  ]);
  const { searchLocal } = fakeSearch([[hit()]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.equal(result.answer, "我再查一下。\n\n答案是 42。");
});

test("history 原样放在 system 与当前问题之间，由调用方负责截断", async () => {
  const config = loadConfig({ QUERY_REWRITE: "false" }).config;
  const { chat, calls } = fakeChat([{ content: "答" }]);
  const { searchLocal } = fakeSearch([[hit()]]);
  const history = [
    { role: /** @type {const} */ ("user"), content: "上一问" },
    { role: /** @type {const} */ ("assistant"), content: "上一答" },
  ];
  await createAgent({ config, chat, searchLocal }).answer("问题", { history });
  assert.deepEqual(
    calls[0].messages.slice(1, 4).map((/** @type {any} */ m) => m.content),
    ["上一问", "上一答", "问题"],
  );
});

const history = [
  { role: /** @type {const} */ ("user"), content: "我的项目代号是什么？" },
  { role: /** @type {const} */ ("assistant"), content: "我的项目代号是 Kestrel。" },
];

test("有对话历史时先改写追问，用改写结果检索本地知识库", async () => {
  const { chat, calls } = fakeChat([{ content: "Kestrel 是做什么用的？" }, { content: "答" }]);
  const { searchLocal, queries } = fakeSearch([[hit()]]);
  /** @type {any[]} */
  const events = [];
  await createAgent({ config: baseConfig, chat, searchLocal }).answer("它是做什么用的？", {
    history,
    onDelta: (e) => events.push(e),
  });
  assert.deepEqual(queries, ["Kestrel 是做什么用的？"]);
  assert.equal(calls[0].think, false);
  assert.equal(calls[0].tools, undefined);
  assert.match(calls[0].messages[1].content, /Kestrel/);
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("Kestrel 是做什么用的？")));
  // 回答时模型看到的仍是用户原话
  assert.equal(calls[1].messages.at(-3).content, "它是做什么用的？");
});

test("没有对话历史时不改写，不多调用一次模型", async () => {
  const { chat, calls } = fakeChat([{ content: "答" }]);
  const { searchLocal, queries } = fakeSearch([[hit()]]);
  await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.equal(calls.length, 1);
  assert.deepEqual(queries, ["问题"]);
});

test("改写失败时退回原问题，回答照常进行", async () => {
  let n = 0;
  /** @type {typeof import("../src/core/ollama.js").chatStream} */
  const chat = async () => {
    if (++n === 1) throw new Error("模型出错");
    return { role: "assistant", content: "答", thinking: "" };
  };
  const { searchLocal, queries } = fakeSearch([[hit()]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("它呢？", { history });
  assert.deepEqual(queries, ["它呢？"]);
  assert.equal(result.answer, "答");
});

test("联网搜索仍然只发送用户输入的原文，不发送改写结果", async () => {
  const { chat } = fakeChat([{ content: "Kestrel 最新版本是什么？" }, { content: "答" }]);
  const { searchLocal } = fakeSearch([[]]);
  /** @type {string[]} */
  const webQueries = [];
  /** @param {string} q */
  const searchWeb = async (q) => {
    webQueries.push(q);
    return {
      results: [{ kind: /** @type {const} */ ("web"), title: "T", url: "https://x.com", snippet: "S" }],
      error: null,
    };
  };
  await createAgent({ config: webConfig, chat, searchLocal, searchWeb }).answer("它最新版本是什么？", { history });
  assert.deepEqual(webQueries, ["它最新版本是什么？"]);
});

test("cleanRewrite：去掉前缀和引号，只取第一行，过长视为失败", () => {
  assert.equal(cleanRewrite("改写后的问题：「Kestrel 是做什么用的？」\n解释……"), "Kestrel 是做什么用的？");
  assert.equal(cleanRewrite('  "Kestrel 的用途"  '), "Kestrel 的用途");
  assert.equal(cleanRewrite(""), "");
  assert.equal(cleanRewrite("长".repeat(201)), "");
});

test("取消：模型生成被中止时向上抛出 AbortError，而不是当成工具错误吞掉", async () => {
  const controller = new AbortController();
  const chat = async () => {
    controller.abort();
    throw new DOMException("已取消", "AbortError");
  };
  const { searchLocal } = fakeSearch([[hit()]]);
  await assert.rejects(
    createAgent({ config: baseConfig, chat, searchLocal }).answer("问题", { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("模型 content 为空就结束时，不提供工具、补收尾提示再生成一次", async () => {
  const { chat, calls } = fakeChat([{ thinking: "答案写进了思考过程" }, { content: "正式答案" }]);
  const { searchLocal } = fakeSearch([[hit()]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].tools, undefined);
  assert.match(calls[1].messages.at(-1).content, /不要再调用工具/);
  assert.equal(result.answer, "正式答案");
});

test("重试后仍为空时给出兜底提示，不会无限循环", async () => {
  const { chat, calls } = fakeChat([{ thinking: "只有思考" }]);
  const { searchLocal } = fakeSearch([[hit()]]);
  const result = await createAgent({ config: baseConfig, chat, searchLocal }).answer("问题");
  assert.equal(calls.length, 2);
  assert.equal(result.answer, "（模型没有返回内容）");
});

test("buildSystemPrompt：未开联网时只提本地知识库，不出现 search_web", () => {
  const prompt = buildSystemPrompt(false);
  assert.doesNotMatch(prompt, /search_web|网络/);
  assert.match(prompt, /知识库中没有相关信息/);
});

test("buildSystemPrompt：开启联网时是一份完整规则，不靠「放宽」前文，编号连续", () => {
  const prompt = buildSystemPrompt(true);
  assert.match(prompt, /search_web/);
  assert.doesNotMatch(prompt, /放宽|只能依据 search_knowledge_base/);
  assert.doesNotMatch(prompt, /「知识库中没有相关信息」/); // 兜底话术只有一种，不与本地模式混用
  const numbers = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
  );
});
