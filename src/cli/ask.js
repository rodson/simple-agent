// @ts-check
import { assertConfig } from "../core/config.js";
import { errorMessage } from "../core/errors.js";
import { createAgent } from "../core/agent.js";
import { createPrinter } from "./output.js";

const USAGE = '用法：npm run ask -- [--thinking] "你的问题"';

// 只认 --thinking 这一个开关，其余原样拼成问题（问题本身可能以 - 开头）
const args = process.argv.slice(2);
const showThinking = args.includes("--thinking");
const question = args
  .filter((arg) => arg !== "--thinking")
  .join(" ")
  .trim();
if (!question) {
  console.error(USAGE);
  process.exit(1);
}

// ask 的 stdout 常被脚本消费：思考过程默认不展示，加 --thinking 才展示，且写到 stderr。
// 这里刻意不看 SHOW_THINKING，否则复制了 .env.example 的用户都会被打开。
const printer = createPrinter({
  showThinking,
  answerOut: process.stdout,
  thinkingOut: process.stderr,
});

try {
  assertConfig();
  const result = await createAgent().answer(question, { onDelta: printer.onDelta });
  printer.finish(result);
} catch (err) {
  console.error(`❌ ${errorMessage(err)}`);
  process.exitCode = 1;
}
