// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录：.env 与相对路径的 DOCS_DIR 都以它为基准，与从哪个目录启动无关。 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * @typedef {object} Config
 * @property {string} ollamaHost
 * @property {string} chatModel
 * @property {string} embedModel
 * @property {string} chromaHost
 * @property {number} chromaPort
 * @property {string} collection
 * @property {number} topK
 * @property {number} minSimilarity 低于该相似度的片段不交给模型、也不列为来源
 * @property {number} chunkSize
 * @property {number} chunkOverlap
 * @property {string} docsDir 绝对路径
 * @property {number} maxToolRounds
 * @property {number} historyTurns
 * @property {boolean} showThinking
 * @property {boolean} queryRewrite 有对话历史时，先结合上下文把追问改写成独立的检索语句
 * @property {boolean} webSearch
 * @property {string} tavilyApiKey
 */

/**
 * 从环境变量解析配置。不会抛异常：非法值回退到默认值，并把问题收集进 errors，
 * 由各个入口统一打印友好提示（doctor 也能借此报告配置问题）。
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: Readonly<Config>, errors: string[] }}
 */
export function loadConfig(env) {
  /** @type {string[]} */
  const errors = [];

  /** @param {string} key @param {string} fallback */
  const str = (key, fallback) => env[key]?.trim() || fallback;

  /** @param {string} key @param {number} fallback @param {number} [min] */
  const int = (key, fallback, min = 1) => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min) return value;
    errors.push(`${key} 必须是${min === 0 ? "非负" : "正"}整数，当前值：${raw}`);
    return fallback;
  };

  /** @param {string} key @param {number} fallback */
  const ratio = (key, fallback) => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
    errors.push(`${key} 必须是 0 到 1 之间的数，当前值：${raw}`);
    return fallback;
  };

  /** @param {string} key @param {boolean} fallback */
  const bool = (key, fallback) => {
    const raw = env[key]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    errors.push(`${key} 必须是 true/false，当前值：${env[key]}`);
    return fallback;
  };

  /** @type {Config} */
  const config = {
    ollamaHost: str("OLLAMA_HOST", "http://127.0.0.1:11434").replace(/\/+$/, ""),
    chatModel: str("CHAT_MODEL", "qwen3.5:9b"),
    embedModel: str("EMBED_MODEL", "bge-m3"),
    chromaHost: str("CHROMA_HOST", "127.0.0.1"),
    chromaPort: int("CHROMA_PORT", 8000),
    collection: str("COLLECTION", "personal_kb"),
    topK: int("TOP_K", 4),
    minSimilarity: ratio("MIN_SIMILARITY", 0.45),
    chunkSize: int("CHUNK_SIZE", 512),
    chunkOverlap: int("CHUNK_OVERLAP", 60, 0),
    docsDir: path.resolve(projectRoot, str("DOCS_DIR", "docs")),
    maxToolRounds: int("MAX_TOOL_ROUNDS", 5),
    historyTurns: int("HISTORY_TURNS", 7),
    showThinking: bool("SHOW_THINKING", true),
    queryRewrite: bool("QUERY_REWRITE", true),
    webSearch: bool("WEB_SEARCH", false),
    tavilyApiKey: str("TAVILY_API_KEY", ""),
  };

  if (config.webSearch && !config.tavilyApiKey) {
    errors.push("已开启 WEB_SEARCH，但没有配置 TAVILY_API_KEY（https://app.tavily.com 获取），或者关闭 WEB_SEARCH");
  }
  // 换行优先断句可能把窗口提前到 60%，overlap 过大时会退化出大量极小片段
  if (config.chunkOverlap * 2 > config.chunkSize) {
    errors.push(`CHUNK_OVERLAP（${config.chunkOverlap}）不应超过 CHUNK_SIZE（${config.chunkSize}）的一半`);
  }
  return { config: Object.freeze(config), errors };
}

/** @type {string[]} */
const envFileErrors = [];
// Node 内置的 .env 读取：只填充尚未设置的变量，所以系统环境变量优先；没有 .env 就用默认值
try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch (err) {
  const error = /** @type {NodeJS.ErrnoException} */ (err);
  if (error.code !== "ENOENT") envFileErrors.push(`无法读取 .env：${error.message}`);
}

const loaded = loadConfig(process.env);

export const config = loaded.config;
export const configErrors = [...envFileErrors, ...loaded.errors];

/** 入口启动时调用：配置有误就抛出一条汇总了所有问题的错误。 */
export function assertConfig() {
  if (configErrors.length === 0) return;
  throw new Error(`配置有误，请检查 .env：\n${configErrors.map((e) => `  - ${e}`).join("\n")}`);
}
