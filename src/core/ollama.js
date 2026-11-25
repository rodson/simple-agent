// @ts-check
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { abortError, errorMessage } from "./errors.js";

/** 等到响应开始的上限（含首次加载模型），之后流式生成多久都不打断。 */
const FIRST_BYTE_TIMEOUT_MS = 300_000;
/** 流式生成中连续多久没有任何新输出就判定为卡住。 */
const IDLE_TIMEOUT_MS = 120_000;
/** 查询模型列表这类轻量请求的超时。 */
const QUICK_TIMEOUT_MS = 10_000;
/** 模型在内存里保留多久，避免每次提问都重新加载。 */
const KEEP_ALIVE = "10m";
/** Ollama 默认上下文较小，中文 RAG 资料容易被静默截断；温度调低让回答更贴近资料。 */
const CHAT_OPTIONS = { temperature: 0.1, num_ctx: 16384 };

/**
 * @typedef {{ function: { name: string, arguments: unknown } }} ToolCall
 * @typedef {{ role: "system" | "user" | "assistant" | "tool", content: string, tool_calls?: ToolCall[], tool_name?: string }} ChatMessage
 * @typedef {{ role: "assistant", content: string, thinking: string, tool_calls?: ToolCall[] }} AssistantMessage
 * @typedef {{ type: "function", function: { name: string, description: string, parameters: object } }} ToolSchema
 */

/** @param {string} reason */
const ollamaDown = (reason) =>
  new Error(`无法连接 Ollama（${config.ollamaHost}）：${reason}\n请确认 Ollama 已安装并运行：ollama serve`);

/**
 * 访问 Ollama 的唯一出口：统一超时、取消与错误提示。
 * timeoutMs 只限制「等到响应开始」的时间，拿到响应头就停止计时；
 * 这里不用 AbortSignal.timeout，因为它会继续作用于响应体，把耗时较长的流式生成误杀。
 * @param {string} path
 * @param {{ body?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
async function request(path, { body, timeoutMs = FIRST_BYTE_TIMEOUT_MS, signal } = {}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.ollamaHost}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw ollamaDown(timeout.signal.aborted ? `超过 ${timeoutMs / 1000} 秒未响应` : errorMessage(err));
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404 && body?.model) {
    throw new Error(`Ollama 里没有模型 ${body.model}。请先执行：npm run models（或 ollama pull ${body.model}）`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`Ollama ${path} 返回 HTTP ${response.status}：${detail}`);
  }
  return response;
}

/**
 * 把一批文本转成向量；返回数组顺序与输入一致。
 * @param {string[]} texts
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<number[][]>}
 */
export async function embed(texts, { signal } = {}) {
  if (texts.length === 0) return [];
  const response = await request("/api/embed", {
    body: { model: config.embedModel, input: texts, truncate: true }, // 超长片段截断而不是直接报错
    signal,
  });
  const { embeddings } = /** @type {{ embeddings?: number[][] }} */ (await response.json());
  if (!embeddings || embeddings.length !== texts.length || embeddings.some((v) => !v?.length)) {
    throw new Error("Ollama 返回的向量数量不符或为空，请检查 EMBED_MODEL 是否正确");
  }
  return embeddings;
}

/**
 * 流式对话：/api/chat 每行返回一个 JSON（NDJSON），message.thinking / message.content 都是增量片段。
 * onDelta(type, text) 实时收到增量（type 为 "thinking" 或 "content"）；
 * 返回累积后的完整 message。tool_calls 由模型在流末尾一次性给出，不会分片。
 * think=false 时关闭模型的思考过程（qwen3.5 等支持 thinking 的模型）。
 * @param {{
 *   messages: ChatMessage[],
 *   tools?: ToolSchema[],
 *   onDelta?: (type: "thinking" | "content", text: string) => void,
 *   think?: boolean,
 *   signal?: AbortSignal,
 * }} params
 * @returns {Promise<AssistantMessage>}
 */
export async function chatStream({ messages, tools, onDelta, think, signal }) {
  const idle = new AbortController();
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  const response = await request("/api/chat", {
    // think 不传时由模型自行决定；改写检索词这类小任务传 false，省掉思考时间
    body: {
      model: config.chatModel,
      messages,
      tools,
      think,
      stream: true,
      keep_alive: KEEP_ALIVE,
      options: CHAT_OPTIONS,
    },
    signal: combined,
  });

  /** @type {AssistantMessage} */
  const message = { role: "assistant", content: "", thinking: "" };
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    resetIdleTimer();
    const body = /** @type {import("node:stream/web").ReadableStream} */ (response.body);
    const lines = createInterface({ input: Readable.fromWeb(body), crlfDelay: Infinity });
    for await (const line of lines) {
      resetIdleTimer();
      if (!line.trim()) continue;

      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch (err) {
        throw new Error(`Ollama /api/chat 返回了无法解析的数据：${line.slice(0, 200)}`, { cause: err });
      }
      if (chunk.error) throw new Error(`Ollama /api/chat 返回错误：${chunk.error}`);

      const { thinking, content, tool_calls: toolCalls } = chunk.message ?? {};
      if (thinking) {
        message.thinking += thinking;
        onDelta?.("thinking", thinking);
      }
      if (content) {
        message.content += content;
        onDelta?.("content", content);
      }
      if (toolCalls?.length) message.tool_calls = [...(message.tool_calls ?? []), ...toolCalls];
      if (chunk.done) break;
    }
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (idle.signal.aborted)
      throw new Error(`Ollama 超过 ${IDLE_TIMEOUT_MS / 1000} 秒没有新输出，已中止`, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return message;
}

/**
 * 本机已下载的模型名列表。
 * @returns {Promise<string[]>}
 */
export async function listModels() {
  const response = await request("/api/tags", { timeoutMs: QUICK_TIMEOUT_MS });
  const data = /** @type {{ models?: { name: string }[] }} */ (await response.json());
  return (data.models ?? []).map((model) => model.name);
}

/** @param {string} name */
const normalizeModelName = (name) => name.replace(/:latest$/, "");

/**
 * Ollama 把 `bge-m3` 存成 `bge-m3:latest`，比较时需要忽略这个后缀。
 * @param {string[]} names
 * @param {string} model
 */
export function hasModel(names, model) {
  return names.some((name) => normalizeModelName(name) === normalizeModelName(model));
}
