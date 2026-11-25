// @ts-check
import { spawnSync } from "node:child_process";
import { assertConfig, config } from "../core/config.js";
import { errorMessage } from "../core/errors.js";

// 按当前配置拉取模型：改了 CHAT_MODEL / EMBED_MODEL 后执行 npm run models 即可
try {
  assertConfig();
} catch (err) {
  console.error(`❌ ${errorMessage(err)}`);
  process.exit(1);
}

for (const model of new Set([config.chatModel, config.embedModel])) {
  console.log(`$ ollama pull ${model}`);
  const result = spawnSync("ollama", ["pull", model], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    const reason =
      /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ENOENT"
        ? "找不到 ollama 命令，请先安装：https://ollama.com/download"
        : `ollama pull ${model} 失败`;
    console.error(`❌ ${reason}`);
    process.exit(1);
  }
}
