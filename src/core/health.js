// @ts-check
import { config, configErrors } from "./config.js";
import { errorMessage } from "./errors.js";
import { listModels, hasModel } from "./ollama.js";
import { heartbeat, count } from "./store.js";

/**
 * @typedef {{ ok: boolean, label: string, hint?: string }} Check
 */

/**
 * 依次检查配置、Ollama、模型、Chroma 与集合，只返回结果、不打印。
 * hint 只在需要用户处理时出现（检查通过但知识库为空时也会给出提示）。
 * @returns {Promise<Check[]>}
 */
export async function runChecks() {
  /** @type {Check[]} */
  const checks = [];

  checks.push(
    configErrors.length === 0
      ? { ok: true, label: "配置有效" }
      : { ok: false, label: "配置有误", hint: configErrors.join("\n") },
  );

  try {
    const models = await listModels();
    checks.push({ ok: true, label: "Ollama 服务可达" });
    for (const [kind, model] of [
      ["对话模型", config.chatModel],
      ["向量模型", config.embedModel],
    ]) {
      const ok = hasModel(models, model);
      checks.push({ ok, label: `${kind} ${model}`, hint: ok ? undefined : "执行 npm run models" });
    }
  } catch (err) {
    checks.push({ ok: false, label: "Ollama 服务不可达", hint: errorMessage(err) });
  }

  try {
    await heartbeat();
    checks.push({ ok: true, label: "Chroma 服务可达" });
  } catch (err) {
    checks.push({ ok: false, label: "Chroma 服务不可达", hint: errorMessage(err) });
    return checks; // 连不上就不必再查集合，避免重复报同一个错误
  }

  try {
    const total = await count();
    checks.push({
      ok: true,
      label: `集合 ${config.collection}：${total} 个片段`,
      hint: total === 0 ? "把 .md / .txt 放进文档目录，然后执行 npm run ingest" : undefined,
    });
  } catch (err) {
    checks.push({ ok: false, label: "无法读取知识库集合", hint: errorMessage(err) });
  }

  return checks;
}
