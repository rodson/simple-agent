import { config } from "./config.js";
import { answerOnce, formatSources, formatThinking } from "./agent.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法：npm run ask -- "你的问题"');
  process.exit(1);
}

// ask 的 stdout 常被脚本消费：默认不展示思考过程，只有用户显式设置 SHOW_THINKING
// 才展示，且写到 stderr。config 已负责解析与校验该值，这里只判断是否显式设置过。
const showThinking = Boolean(process.env.SHOW_THINKING?.trim()) && config.showThinking;

try {
  const { answer, sources, thinking } = await answerOnce(question);
  if (showThinking) {
    const block = formatThinking(thinking);
    if (block) console.error(block.trim());
  }
  console.log(answer + formatSources(sources));
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
}
