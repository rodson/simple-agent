import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { openCollection, resetCollection, upsertChunks, deleteByIds, listRecords, chunkId, count } from "./store.js";

const EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 递归扫描文档目录；source 使用相对路径，保证 chunk ID 稳定。 */
export async function scanDocs(root = config.docsDir) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if ((await stat(full)).size > MAX_FILE_BYTES) {
          console.warn(`  跳过超大文件（>2MB）：${full}`);
          continue;
        }
        const text = await readFile(full, "utf8");
        files.push({ source: path.relative(config.docsDir, full).split(path.sep).join("/"), text });
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.source.localeCompare(b.source));
}

/** 按字符滑窗切块，尽量在换行处断开；保留 overlap 以维持上下文连续。 */
export function splitText(text, size = config.chunkSize, overlap = config.chunkOverlap) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const earliestBreak = start + Math.floor(size * 0.6);
      const newline = clean.lastIndexOf("\n", end);
      if (newline > earliestBreak) end = newline + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1); // 保证一定前进，避免死循环
  }
  return chunks;
}

export function chunkFile(source, text) {
  return splitText(text).map((piece, index) => ({ source, chunk: index, text: piece }));
}

/** 文件内容 + 切块参数的哈希：任何一项变了，这个文件都需要重新导入。 */
function fileHash(text) {
  return createHash("sha1").update(`${config.chunkSize}|${config.chunkOverlap}|${text}`).digest("hex");
}

/**
 * 增量导入：
 * - 内容没变的文件直接跳过，不重复计算向量
 * - 变了的文件先写入新片段，全部成功后再删除多余的旧片段，中途失败也不会把知识库删空
 * - 磁盘上已删除的文件，其片段也一并清理
 */
export async function ingestDocs({ reset = false } = {}) {
  const files = await scanDocs();
  if (files.length === 0) {
    console.warn(`⚠️  ${config.docsDir}/ 里没有找到 .md / .markdown / .txt 文档，未做任何改动。`);
    return { files: 0, chunks: 0 };
  }

  if (reset) await resetCollection();
  else await openCollection(); // 触发向量模型一致性校验

  const records = await listRecords();
  const oldBySource = Map.groupBy(records, (row) => row.source);
  const keepIds = new Set(); // 导入结束后应该留在库里的片段
  const changed = [];

  for (const file of files) {
    const hash = fileHash(file.text);
    const chunks = chunkFile(file.source, file.text).map((chunk) => ({ ...chunk, hash }));
    for (const chunk of chunks) keepIds.add(chunkId(chunk.source, chunk.chunk));

    const old = oldBySource.get(file.source) ?? [];
    const unchanged = old.length === chunks.length && old.every((row) => row.hash === hash);
    if (!unchanged) changed.push({ source: file.source, chunks });
  }

  for (const file of changed) {
    await upsertChunks(file.chunks);
    console.log(`  ${file.source} → ${file.chunks.length} 个片段`);
  }
  await deleteByIds(records.filter((row) => !keepIds.has(row.id)).map((row) => row.id));

  const skipped = files.length - changed.length;
  console.log(
    `✅ 更新 ${changed.length} 个文件，${skipped} 个未变化已跳过（集合现有 ${await count()} 个片段）`,
  );
  return { files: changed.length, skipped };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const reset = process.argv.includes("--reset");
  if (reset) console.log("正在清空并重建知识库…");
  ingestDocs({ reset }).catch((err) => {
    console.error(`❌ 导入失败：${err.message}`);
    process.exitCode = 1;
  });
}
