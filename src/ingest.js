import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  openCollection,
  resetCollection,
  upsertChunks,
  deleteByIds,
  deleteSource,
  listSources,
  count,
} from "./store.js";

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
        const text = await readFile(full, "utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
          console.warn(`  跳过超大文件（>2MB）：${full}`);
          continue;
        }
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

/** 幂等导入：同名文件先删旧块再写新块，磁盘上已删除的文件也一并清理。 */
export async function ingestDocs({ reset = false } = {}) {
  const files = await scanDocs();
  if (files.length === 0) {
    console.warn(`⚠️  ${config.docsDir}/ 里没有找到 .md / .markdown / .txt 文档，未做任何改动。`);
    return { files: 0, chunks: 0 };
  }

  if (reset) await resetCollection();
  else await openCollection(); // 触发向量模型一致性校验

  const sources = new Set(files.map((file) => file.source));
  const existing = await listSources();
  await deleteByIds(
    existing.filter((row) => !row.source || !sources.has(row.source)).map((row) => row.id),
  );

  const byFile = files.map((file) => ({
    source: file.source,
    chunks: chunkFile(file.source, file.text),
  }));
  for (const file of byFile) {
    await deleteSource(file.source); // 文件变短时清掉多余的旧块
  }
  const allChunks = byFile.flatMap((file) => file.chunks);
  await upsertChunks(allChunks);

  for (const file of byFile) console.log(`  ${file.source} → ${file.chunks.length} 个片段`);
  console.log(
    `✅ 已导入 ${byFile.length} 个文件、${allChunks.length} 个片段（集合现有 ${await count()} 条）`,
  );
  return { files: byFile.length, chunks: allChunks.length };
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
