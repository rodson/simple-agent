import { answerOnce, formatSources } from "./agent.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法：npm run ask -- "你的问题"');
  process.exit(1);
}

try {
  const { answer, sources } = await answerOnce(question);
  console.log(answer + formatSources(sources));
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
}
