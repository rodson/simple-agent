import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 极简 .env 读取器：只解析 KEY=VALUE；已存在的系统环境变量优先。 */
function loadEnvFile() {
  let content;
  try {
    content = readFileSync(path.join(projectRoot, ".env"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return; // 没有 .env 就直接用默认值
    throw err;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

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

const raw = {
  ollamaHost: (env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, ""),
  chatModel: env.CHAT_MODEL || "qwen2.5:3b",
  embedModel: env.EMBED_MODEL || "bge-m3",
  chromaHost: env.CHROMA_HOST || "127.0.0.1",
  chromaPort: positiveInt("CHROMA_PORT", 8000),
  collection: env.COLLECTION || "personal_kb",
  topK: positiveInt("TOP_K", 4),
  chunkSize: positiveInt("CHUNK_SIZE", 512),
  chunkOverlap: positiveInt("CHUNK_OVERLAP", 60),
  docsDir: env.DOCS_DIR || "docs",
  maxToolRounds: positiveInt("MAX_TOOL_ROUNDS", 3),
  historyTurns: positiveInt("HISTORY_TURNS", 5),
};

// 换行优先断句可能把窗口提前到 60%，overlap 过大时会退化出大量极小片段
if (raw.chunkOverlap * 2 > raw.chunkSize) {
  throw new Error("CHUNK_OVERLAP 不应超过 CHUNK_SIZE 的一半");
}

export const config = Object.freeze(raw);
