import { config } from "./config.js";

const TIMEOUT_MS = 300_000; // 本地小模型首次加载可能较慢

function ollamaDown(err) {
  return new Error(
    `无法连接 Ollama（${config.ollamaHost}）：${err.message}\n` +
      `请确认 Ollama 已安装并运行：ollama serve`,
  );
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(`${config.ollamaHost}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw ollamaDown(err);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim().slice(0, 300);
    } catch {
      // 忽略读取错误，保留状态码即可
    }
    if (response.status === 404) {
      throw new Error(
        `Ollama 里没有模型 ${body.model}。请先执行：npm run models（或 ollama pull ${body.model}）`,
      );
    }
    throw new Error(`Ollama ${path} 返回 HTTP ${response.status}：${detail}`);
  }
  return response.json();
}

/** 把一批文本转成向量；返回数组顺序与输入一致。 */
export async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const data = await post("/api/embed", {
    model: config.embedModel,
    input: texts,
    truncate: true, // 超长片段截断而不是直接报错
  });
  const vectors = data.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(
      `Ollama 返回的向量数量不符：期望 ${texts.length}，实际 ${vectors?.length ?? "无"}`,
    );
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Ollama 返回了空向量，请检查 EMBED_MODEL 是否正确");
    }
  }
  return vectors;
}

/** 非流式对话；传 tools 时模型可能返回 tool_calls。 */
export async function chat({ messages, tools }) {
  const body = {
    model: config.chatModel,
    messages,
    stream: false,
    keep_alive: "10m",
    // Ollama 默认上下文较小，中文 RAG 资料容易被静默截断
    options: { temperature: 0.1, num_ctx: 8192 },
  };
  if (tools?.length) body.tools = tools;
  const data = await post("/api/chat", body);
  if (!data.message) throw new Error("Ollama /api/chat 的响应里没有 message 字段");
  return data.message;
}

/** 本机已下载的模型名列表。 */
export async function listModels() {
  let response;
  try {
    response = await fetch(`${config.ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw ollamaDown(err);
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
