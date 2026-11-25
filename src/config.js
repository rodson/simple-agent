import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Node 内置的 .env 读取：只填充尚未设置的变量，所以系统环境变量优先；没有 .env 就用默认值
try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const env = process.env;

function positiveInt(key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`配置项 ${key} 必须是正整数，当前值：${raw}`);
  }
  return value;
}

function booleanFlag(key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`配置项 ${key} 必须是 true/false，当前值：${raw}`);
}

const raw = {
  ollamaHost: (env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, ""),
  chatModel: env.CHAT_MODEL || "qwen3.5:9b",
  embedModel: env.EMBED_MODEL || "bge-m3",
  chromaHost: env.CHROMA_HOST || "127.0.0.1",
  chromaPort: positiveInt("CHROMA_PORT", 8000),
  collection: env.COLLECTION || "personal_kb",
  topK: positiveInt("TOP_K", 4),
  chunkSize: positiveInt("CHUNK_SIZE", 512),
  chunkOverlap: positiveInt("CHUNK_OVERLAP", 60),
  docsDir: env.DOCS_DIR || "docs",
  maxToolRounds: positiveInt("MAX_TOOL_ROUNDS", 5),
  historyTurns: positiveInt("HISTORY_TURNS", 7),
  showThinking: booleanFlag("SHOW_THINKING", true),
  webSearch: booleanFlag("WEB_SEARCH", false),
  tavilyApiKey: (env.TAVILY_API_KEY || "").trim(),
};

if (raw.webSearch && !raw.tavilyApiKey) {
  throw new Error(
    "已开启 WEB_SEARCH，但没有配置 TAVILY_API_KEY。请在 .env 中填写密钥（https://app.tavily.com 获取），或关闭 WEB_SEARCH",
  );
}

// 换行优先断句可能把窗口提前到 60%，overlap 过大时会退化出大量极小片段
if (raw.chunkOverlap * 2 > raw.chunkSize) {
  throw new Error("CHUNK_OVERLAP 不应超过 CHUNK_SIZE 的一半");
}

export const config = Object.freeze(raw);
