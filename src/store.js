import { ChromaClient } from "chromadb";
import { config } from "./config.js";
import { embed } from "./ollama.js";

const EMBED_BATCH = 16;
const CHROMA_TIMEOUT_MS = 30_000;
const client = new ChromaClient({
  host: config.chromaHost,
  port: config.chromaPort,
  ssl: false,
});

let collectionPromise;

function friendlyError(err) {
  const message = err?.message ?? String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|connect|timeout|超时/i.test(message)) {
    return new Error(
      `无法连接 Chroma（${config.chromaHost}:${config.chromaPort}）：${message}\n` +
        `请另开一个终端执行：npm run chroma`,
    );
  }
  if (/dimension|dimensional|expected.*vector/i.test(message)) {
    return new Error(
      `向量维度不匹配：${message}\n` +
        `如果更换过 EMBED_MODEL，请执行：npm run reset && npm run ingest`,
    );
  }
  return err;
}

async function run(operation) {
  let timer;
  try {
    // Chroma 客户端自身没有请求超时；服务卡住时不能让 CLI 永远挂着
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Chroma 请求超时（${CHROMA_TIMEOUT_MS}ms）`)),
          CHROMA_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    throw friendlyError(err);
  } finally {
    clearTimeout(timer);
  }
}

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
  if (!collectionPromise) {
    collectionPromise = (async () => {
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
      collectionPromise = undefined;
      throw err;
    });
  }
  return collectionPromise;
}

/** 删除并重建集合（切换向量模型后必须执行）。 */
export async function resetCollection() {
  try {
    await client.deleteCollection({ name: config.collection });
  } catch {
    // 集合不存在时无需处理；其他连接问题会在 openCollection 时暴露
  }
  collectionPromise = undefined;
  return openCollection();
}

/** 片段 ID 直接用「相对路径#序号」，可读、稳定，重复导入同一片段会覆盖而不是新增。 */
export function chunkId(source, index) {
  return `${source}#${index}`;
}

/** 批量计算向量并写入；chunk 形如 { source, chunk, hash, text }，相同 ID 会覆盖。 */
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

/** 向量检索；返回按相似度从高到低排列的片段。 */
export async function search(text, topK = config.topK) {
  const collection = await openCollection();
  const total = await run(() => collection.count());
  if (total === 0) return [];

  const [vector] = await embed([text]);
  const result = await run(() =>
    collection.query({
      queryEmbeddings: [vector],
      nResults: Math.min(topK, total),
      include: ["documents", "metadatas", "distances"],
    }),
  );

  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  return documents
    .map((document, i) => ({
      source: metadatas[i]?.source ?? "未知来源",
      chunk: Number(metadatas[i]?.chunk ?? i),
      text: document ?? "",
      // cosine 距离 = 1 - 余弦相似度，越小越相关
      similarity: typeof distances[i] === "number" ? 1 - distances[i] : null,
    }))
    .filter((item) => item.text.length > 0);
}

/** 列出集合内所有记录的 ID、来源文件与内容哈希，用于增量导入和清理。 */
export async function listRecords() {
  const collection = await openCollection();
  const result = await run(() => collection.get({ limit: 100_000, include: ["metadatas"] }));
  return result.ids.map((id, i) => ({
    id,
    source: result.metadatas[i]?.source ?? null,
    hash: result.metadatas[i]?.hash ?? null,
  }));
}

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
