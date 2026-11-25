import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { config } from "./config.js";

// 只限制「等到响应开始」的时间（含首次加载模型）；之后流式生成多久都不打断
const TIMEOUT_MS = 300_000;

const ollamaDown = (reason) =>
  new Error(`无法连接 Ollama（${config.ollamaHost}）：${reason}\n请确认 Ollama 已安装并运行：ollama serve`);

async function request(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${config.ollamaHost}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err.name === "AbortError" ? `超过 ${TIMEOUT_MS / 1000} 秒未响应` : err.message;
    throw ollamaDown(reason);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    throw new Error(`Ollama 里没有模型 ${body.model}。请先执行：npm run models（或 ollama pull ${body.model}）`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`Ollama ${path} 返回 HTTP ${response.status}：${detail}`);
  }
  return response;
}

/** 把一批文本转成向量；返回数组顺序与输入一致。 */
export async function embed(texts) {
  if (texts.length === 0) return [];
  const response = await request("/api/embed", {
    model: config.embedModel,
    input: texts,
    truncate: true, // 超长片段截断而不是直接报错
  });
  const { embeddings } = await response.json();
  if (embeddings?.length !== texts.length || embeddings.some((v) => !v?.length)) {
    throw new Error("Ollama 返回的向量数量不符或为空，请检查 EMBED_MODEL 是否正确");
  }
  return embeddings;
}

/**
 * 流式对话：/api/chat 每行返回一个 JSON（NDJSON），message.thinking / message.content 都是增量片段。
 * onDelta(type, text) 实时收到增量（type 为 "thinking" 或 "content"）；
 * 返回累积后的完整 message：{ role, content, thinking, tool_calls? }。
 * tool_calls 由模型在流末尾一次性给出，不会分片。
 */
export async function chatStream({ messages, tools, onDelta }) {
  const response = await request("/api/chat", {
    model: config.chatModel,
    messages,
    tools,
    stream: true,
    keep_alive: "10m",
    // Ollama 默认上下文较小，中文 RAG 资料容易被静默截断
    options: { temperature: 0.1, num_ctx: 16384 },
  });

  const message = { role: "assistant", content: "", thinking: "" };
  const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
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
  return message;
}

/** 本机已下载的模型名列表。 */
export async function listModels() {
  let response;
  try {
    response = await fetch(`${config.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw ollamaDown(err.message);
  }
  if (!response.ok) throw new Error(`Ollama /api/tags 返回 HTTP ${response.status}`);
  const data = await response.json();
  return (data.models ?? []).map((model) => model.name);
}

const normalize = (name) => name.replace(/:latest$/, "");

/** Ollama 把 `bge-m3` 存成 `bge-m3:latest`，比较时需要忽略这个后缀。 */
export function hasModel(names, model) {
  return names.some((name) => normalize(name) === normalize(model));
}
