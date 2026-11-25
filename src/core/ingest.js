// @ts-check
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { openCollection, resetCollection, upsertChunks, deleteByIds, listRecords, chunkId, count } from "./store.js";

const EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 切块时最早允许在窗口的多少比例处断行，避免为了找换行切出过短的片段。 */
const EARLIEST_BREAK_RATIO = 0.6;

/**
 * @typedef {import("./store.js").Chunk} Chunk
 * @typedef {{ source: string, text: string }} DocFile
 * @typedef {{
 *   exists: boolean,
 *   files: DocFile[],
 *   skipped: string[],
 * }} ScanResult
 * @typedef {{
 *   docsDir: string,
 *   missingDir: boolean,
 *   reset: boolean,
 *   updated: { source: string, chunks: number }[],
 *   unchanged: number,
 *   removedSources: string[],
 *   tooLarge: string[],
 *   total: number,
 * }} IngestReport
 */

/**
 * 递归扫描文档目录；source 使用相对 root 的路径（统一用 /），保证 chunk ID 稳定。
 * @param {string} [root]
 * @returns {Promise<ScanResult>}
 */
export async function scanDocs(root = config.docsDir) {
  /** @type {DocFile[]} */
  const files = [];
  /** @type {string[]} */
  const skipped = [];

  /** @param {string} dir */
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      const source = path.relative(root, full).split(path.sep).join("/");
      if ((await stat(full)).size > MAX_FILE_BYTES) {
        skipped.push(source);
        continue;
      }
      files.push({ source, text: await readFile(full, "utf8") });
    }
  }

  try {
    await walk(root);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return { exists: false, files: [], skipped };
    throw err;
  }
  files.sort((a, b) => a.source.localeCompare(b.source));
  return { exists: true, files, skipped };
}

/**
 * 按字符滑窗切块，尽量在换行处断开；保留 overlap 以维持上下文连续。
 * @param {string} text
 * @param {number} [size]
 * @param {number} [overlap]
 */
export function splitText(text, size = config.chunkSize, overlap = config.chunkOverlap) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  /** @type {string[]} */
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const earliestBreak = start + Math.floor(size * EARLIEST_BREAK_RATIO);
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

/**
 * @param {string} source
 * @param {string} text
 * @returns {Chunk[]}
 */
export function chunkFile(source, text) {
  return splitText(text).map((piece, index) => ({ source, chunk: index, text: piece }));
}

/**
 * 文件内容 + 切块参数的哈希：任何一项变了，这个文件都需要重新导入。
 * @param {string} text
 */
function fileHash(text) {
  return createHash("sha1").update(`${config.chunkSize}|${config.chunkOverlap}|${text}`).digest("hex");
}

/**
 * 增量导入，只返回报告、不直接打印（展示交给 CLI）：
 * - 内容没变的文件直接跳过，不重复计算向量
 * - 变了的文件先写入新片段，全部成功后再删除多余的旧片段，中途失败也不会把知识库删空
 * - 磁盘上已删除的文件，其片段也一并清理（目录存在但为空时会清空知识库）
 * - 文档目录不存在时视为配置错误，除了 reset 之外不做任何改动，防止 DOCS_DIR 写错把库删光
 * @param {{ reset?: boolean, onFile?: (source: string, chunks: number) => void }} [options]
 * @returns {Promise<IngestReport>}
 */
export async function ingestDocs({ reset = false, onFile } = {}) {
  const scan = await scanDocs();
  if (reset) await resetCollection();
  else await openCollection(); // 触发向量模型一致性校验

  /** @type {IngestReport} */
  const report = {
    docsDir: config.docsDir,
    missingDir: !scan.exists,
    reset,
    updated: [],
    unchanged: 0,
    removedSources: [],
    tooLarge: scan.skipped,
    total: 0,
  };
  if (!scan.exists) {
    report.total = await count();
    return report;
  }

  const records = await listRecords();
  const oldBySource = Map.groupBy(records, (row) => row.source);
  const keepIds = new Set(); // 导入结束后应该留在库里的片段

  for (const file of scan.files) {
    const hash = fileHash(file.text);
    const chunks = chunkFile(file.source, file.text).map((chunk) => ({ ...chunk, hash }));
    for (const chunk of chunks) keepIds.add(chunkId(chunk.source, chunk.chunk));

    const old = oldBySource.get(file.source) ?? [];
    if (old.length === chunks.length && old.every((row) => row.hash === hash)) {
      report.unchanged++;
      continue;
    }
    await upsertChunks(chunks);
    report.updated.push({ source: file.source, chunks: chunks.length });
    onFile?.(file.source, chunks.length);
  }

  const stale = records.filter((row) => !keepIds.has(row.id));
  await deleteByIds(stale.map((row) => row.id));

  const present = new Set(scan.files.map((file) => file.source));
  report.removedSources = [...new Set(stale.map((row) => row.source ?? "未知来源"))].filter(
    (source) => !present.has(source),
  );
  report.total = await count();
  return report;
}
