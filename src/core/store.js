// @ts-check
import { ChromaClient } from "chromadb";
import { config } from "./config.js";
import { embed } from "./ollama.js";

/** 每批计算多少个片段的向量。 */
const EMBED_BATCH = 16;
/** 列出记录时每页条数。 */
const PAGE_SIZE = 1000;
const CHROMA_TIMEOUT_MS = 30_000;

const client = new ChromaClient({ host: config.chromaHost, port: config.chromaPort, ssl: false });

/**
 * @typedef {import("chromadb").Collection} Collection
 * @typedef {{ source: string, chunk: number, text: string }} Chunk
 * @typedef {Chunk & { hash: string }} HashedChunk
 * @typedef {Chunk & { similarity: number | null }} SearchHit
 * @typedef {{ id: string, source: string | null, hash: string | null }} RecordInfo
 */

/** @type {Promise<Collection> | undefined} */
let collectionPromise;

/** @param {unknown} err */
function friendlyError(err) {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "ChromaConnectionError" || error.name === "ChromaTimeoutError") {
    return new Error(
      `无法连接 Chroma（${config.chromaHost}:${config.chromaPort}）：${error.message}\n请另开一个终端执行：npm run chroma`,
    );
  }
  if (/dimension|expected.*vector/i.test(error.message)) {
    return new Error(
      `向量维度不匹配：${error.message}\n如果更换过 EMBED_MODEL，请执行：npm run reset && npm run ingest`,
    );
  }
  return error;
}

/**
 * 执行一次 Chroma 操作：加超时并把常见错误翻译成可操作的提示。
 * Chroma 客户端不支持给单次请求传 signal，只能用 Promise.race 让 CLI 不再傻等（底层请求不会被取消）。
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function run(operation) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`请求超过 ${CHROMA_TIMEOUT_MS / 1000} 秒没有响应`);
      error.name = "ChromaTimeoutError";
      reject(error);
    }, CHROMA_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } catch (err) {
    throw friendlyError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Collection} collection */
function assertEmbedModel(collection) {
  const stored = collection.metadata?.embed_model;
  if (stored && stored !== config.embedModel) {
    throw new Error(
      `知识库是用向量模型 ${stored} 建立的，当前配置是 ${config.embedModel}。\n` +
        `更换 EMBED_MODEL 后必须重建：npm run reset && npm run ingest`,
    );
  }
}

/** 打开（必要时创建）集合；同一进程内复用，避免重复网络往返。 */
export function openCollection() {
  collectionPromise ??= (async () => {
    const collection = await run(() =>
      client.getOrCreateCollection({
        name: config.collection,
        embeddingFunction: null, // 我们自己用 Ollama 算向量
        configuration: { hnsw: { space: "cosine" } },
        metadata: { embed_model: config.embedModel },
      }),
    );
    assertEmbedModel(collection);
    return collection;
  })().catch((err) => {
    collectionPromise = undefined; // 失败后允许下次重试
    throw err;
  });
  return collectionPromise;
}

/** 删除并重建集合（切换向量模型后必须执行）。 */
export async function resetCollection() {
  try {
    await run(() => client.deleteCollection({ name: config.collection }));
  } catch (err) {
    // 集合不存在属于正常情况；连不上之类的问题直接报出来
    if (/** @type {Error} */ (err).name !== "ChromaNotFoundError") throw err;
  }
  collectionPromise = undefined;
  return openCollection();
}

/**
 * 片段 ID 直接用「相对路径#序号」，可读、稳定，重复导入同一片段会覆盖而不是新增。
 * @param {string} source
 * @param {number} index
 */
export function chunkId(source, index) {
  return `${source}#${index}`;
}

/**
 * 批量计算向量并写入；相同 ID 会覆盖。
 * @param {HashedChunk[]} chunks
 */
export async function upsertChunks(chunks) {
  if (chunks.length === 0) return 0;
  const collection = await openCollection();
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map((chunk) => chunk.text));
    await run(() =>
      collection.upsert({
        ids: batch.map((chunk) => chunkId(chunk.source, chunk.chunk)),
        documents: batch.map((chunk) => chunk.text),
        metadatas: batch.map(({ source, chunk, hash }) => ({ source, chunk, hash })),
        embeddings: vectors,
      }),
    );
  }
  return chunks.length;
}

/**
 * 向量检索：返回按相似度从高到低排列的 topK 个片段，不做阈值过滤（由调用方决定）。
 * 集合为空时返回空数组。
 * @param {string} text
 * @param {number} [topK]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<SearchHit[]>}
 */
export async function search(text, topK = config.topK, { signal } = {}) {
  const collection = await openCollection();
  const [vector] = await embed([text], { signal });
  const result = await run(() =>
    collection.query({
      queryEmbeddings: [vector],
      nResults: topK,
      include: ["documents", "metadatas", "distances"],
    }),
  );

  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  return documents
    .map((document, i) => ({
      source: String(metadatas[i]?.source ?? "未知来源"),
      chunk: Number(metadatas[i]?.chunk ?? i),
      text: document ?? "",
      // cosine 距离 = 1 - 余弦相似度，越小越相关
      similarity: typeof distances[i] === "number" ? 1 - distances[i] : null,
    }))
    .filter((item) => item.text.length > 0);
}

/**
 * 分页列出集合内所有记录的 ID、来源文件与内容哈希，用于增量导入和清理。
 * @returns {Promise<RecordInfo[]>}
 */
export async function listRecords() {
  const collection = await openCollection();
  /** @type {RecordInfo[]} */
  const records = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await run(() => collection.get({ limit: PAGE_SIZE, offset, include: ["metadatas"] }));
    page.ids.forEach((id, i) => {
      const meta = page.metadatas[i];
      records.push({
        id,
        source: meta?.source == null ? null : String(meta.source),
        hash: meta?.hash == null ? null : String(meta.hash),
      });
    });
    if (page.ids.length < PAGE_SIZE) return records;
  }
}

/** @param {string[]} ids */
export async function deleteByIds(ids) {
  if (ids.length === 0) return;
  const collection = await openCollection();
  await run(() => collection.delete({ ids }));
}

export async function count() {
  const collection = await openCollection();
  return run(() => collection.count());
}

export async function heartbeat() {
  return run(() => client.heartbeat());
}
