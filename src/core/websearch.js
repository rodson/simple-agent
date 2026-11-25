// @ts-check
import { config } from "./config.js";
import { abortError, errorMessage } from "./errors.js";

/**
 * 联网搜索：本项目唯一发起外部请求的模块。
 * - 只在 WEB_SEARCH=true 时被调用；对外只发送检索词本身（由 agent.js 保证是当前提问）
 * - 后端为 Tavily 搜索 API，需要 TAVILY_API_KEY
 * - 除了用户主动取消，绝不抛异常：失败、超时、无结果一律返回 { results: [], error }，由 Agent 降级到本地知识库
 */

/**
 * @typedef {{ kind: "web", title: string, url: string, snippet: string }} WebResult
 * @typedef {{ results: WebResult[], error: string | null }} WebSearchResponse
 */

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 600;

/** 每次回答至多对外检索的次数。 */
export const WEB_SEARCH_LIMIT = 1;

/** @type {Record<number, string>} */
const STATUS_HINTS = {
  401: "API Key 无效或缺失，请检查 TAVILY_API_KEY",
  429: "请求过于频繁，已被限流",
  432: "已超出套餐用量",
  433: "已超出按量付费限额",
};

/** @param {unknown} text */
const clean = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 清洗 Tavily 返回的结果：只保留 http(s) 链接、标题和摘要齐全的条目，按 URL 去重，截断摘要。
 * @param {unknown} items
 * @returns {WebResult[]}
 */
export function normalizeResults(items) {
  const seen = new Set();
  /** @type {WebResult[]} */
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const url = clean(item?.url);
    const title = clean(item?.title);
    const snippet = clean(item?.content).slice(0, MAX_SNIPPET_CHARS);
    if (!/^https?:\/\//i.test(url) || !title || !snippet || seen.has(url)) continue;
    seen.add(url);
    results.push({ kind: "web", title, url, snippet });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/**
 * 检索公开网络；error 为 null 表示成功（结果可能为空）。
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<WebSearchResponse>}
 */
export async function webSearch(query, { signal } = {}) {
  const q = clean(query);
  if (!q) return { results: [], error: "检索词为空" };

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.tavilyApiKey}` },
      body: JSON.stringify({ query: q, max_results: MAX_RESULTS, search_depth: "basic" }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const hint = STATUS_HINTS[response.status];
      return { results: [], error: `Tavily 返回 HTTP ${response.status}${hint ? `（${hint}）` : ""}` };
    }
    const data = /** @type {{ results?: unknown } | null} */ (await response.json());
    return { results: normalizeResults(data?.results), error: null };
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (timeout.aborted) return { results: [], error: `连接 Tavily 超过 ${TIMEOUT_MS / 1000} 秒未响应` };
    const reason = err instanceof SyntaxError ? "响应无法解析" : "无法连接";
    return { results: [], error: `Tavily ${reason}：${errorMessage(err)}` };
  }
}
