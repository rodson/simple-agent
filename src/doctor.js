import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { listModels, hasModel } from "./ollama.js";
import { heartbeat, count } from "./store.js";

/** 返回 true 表示关键依赖都就绪；quiet 模式供 REPL 启动时静默调用。 */
export async function checkAll({ verbose = true } = {}) {
  const checks = [];
  const say = (text) => {
    if (verbose) console.log(text);
  };
  const record = (ok, label, hint = "") => {
    checks.push(ok);
    say(`${ok ? "✅" : "❌"} ${label}`);
    if (!ok && hint) say(`   → ${hint.replace(/\n/g, "\n   ")}`);
  };

  say("本地知识库体检\n");
  say(`  Ollama  ${config.ollamaHost}  ·  对话 ${config.chatModel}  ·  向量 ${config.embedModel}`);
  say(`  Chroma  ${config.chromaHost}:${config.chromaPort}  ·  集合 ${config.collection}\n`);

  let models = [];
  let ollamaReady = false;
  try {
    models = await listModels();
    ollamaReady = true;
    record(true, "Ollama 服务可达");
  } catch (err) {
    record(false, "Ollama 服务不可达", err.message);
  }

  if (ollamaReady) {
    record(
      hasModel(models, config.chatModel),
      `对话模型 ${config.chatModel}`,
      "执行 npm run models",
    );
    record(
      hasModel(models, config.embedModel),
      `向量模型 ${config.embedModel}`,
      "执行 npm run models",
    );
  }

  try {
    await heartbeat();
    record(true, "Chroma 服务可达");
  } catch (err) {
    record(false, "Chroma 服务不可达", err.message);
  }

  try {
    const total = await count();
    record(true, `集合 ${config.collection}：${total} 个片段`);
    if (total === 0) say("   → 把 .md / .txt 放进 docs/，然后执行 npm run ingest");
  } catch (err) {
    record(false, "无法读取知识库集合", err.message);
  }

  return checks.every(Boolean);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const ok = await checkAll();
  if (!ok) process.exitCode = 1;
}
