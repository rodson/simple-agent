// @ts-check
import { assertConfig } from "../core/config.js";
import { errorMessage } from "../core/errors.js";
import { ingestDocs } from "../core/ingest.js";
import { formatIngestReport } from "./output.js";

try {
  assertConfig();
  const reset = process.argv.includes("--reset");
  if (reset) console.log("正在清空并重建知识库…");
  const report = await ingestDocs({
    reset,
    onFile: (source, chunks) => console.log(`  ${source} → ${chunks} 个片段`),
  });
  console.log(formatIngestReport(report));
} catch (err) {
  console.error(`❌ 导入失败：${errorMessage(err)}`);
  process.exitCode = 1;
}
