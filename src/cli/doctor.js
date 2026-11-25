// @ts-check
import { config } from "../core/config.js";
import { runChecks } from "../core/health.js";
import { formatChecks } from "./output.js";

console.log("本地知识库体检\n");
console.log(`  Ollama  ${config.ollamaHost}  ·  对话 ${config.chatModel}  ·  向量 ${config.embedModel}`);
console.log(`  Chroma  ${config.chromaHost}:${config.chromaPort}  ·  集合 ${config.collection}`);
console.log(`  文档    ${config.docsDir}\n`);

// 体检不调用 assertConfig：配置有误时也要跑完其他检查，把问题一次性列出来
const checks = await runChecks();
console.log(formatChecks(checks));
if (!checks.every((check) => check.ok)) process.exitCode = 1;
