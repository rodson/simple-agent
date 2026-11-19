import { createInterface } from "node:readline/promises";
import { config } from "./config.js";
import { answerOnce, formatSources } from "./agent.js";
import { ingestDocs } from "./ingest.js";
import { resetCollection } from "./store.js";
import { checkAll } from "./doctor.js";

const HELP = `
可用命令：
  /ingest   重新导入 docs/ 里的文档（幂等，改过的文件会更新）
  /reset    清空并重建知识库（需要二次确认）
  /sources  显示上一次回答用到的片段
  /clear    清空对话历史
  /help     显示本帮助
  /exit     退出

直接输入自然语言即可提问，例如：我的项目代号是什么？
`;

async function main() {
  const healthy = await checkAll({ verbose: false });
  if (!healthy) console.log("⚠️  依赖未完全就绪，可运行 npm run doctor 查看细节。\n");

  console.log("本地知识库 Agent（Ollama + Chroma + RAG）");
  console.log("输入问题开始提问，/help 查看命令，/exit 退出。\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY), // 管道输入时不输出终端控制字符
  });
  rl.setPrompt("你 > ");
  rl.on("SIGINT", () => rl.close());

  let history = [];
  let lastSources = [];
  let pendingReset = false;

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    try {
      if (pendingReset) {
        pendingReset = false;
        if (input === "y" || input === "yes") {
          await resetCollection();
          console.log("已清空知识库。请执行 /ingest 重新导入。\n");
        } else {
          console.log("已取消。\n");
        }
      } else if (!input) {
        // 空行，什么也不做
      } else if (input === "/exit" || input === "/quit") {
        break;
      } else if (input === "/help") {
        console.log(HELP);
      } else if (input === "/clear") {
        history = [];
        lastSources = [];
        console.log("已清空对话历史。\n");
      } else if (input === "/sources") {
        console.log(
          lastSources.length ? `${formatSources(lastSources).trimStart()}\n` : "还没有参考来源。\n",
        );
      } else if (input === "/ingest") {
        await ingestDocs();
      } else if (input === "/reset") {
        console.log("⚠️  这会清空向量库。确认请输入 y，取消直接回车。");
        pendingReset = true;
      } else {
        console.log("思考中…");
        const { answer, sources } = await answerOnce(input, history);
        console.log(`\n助手 > ${answer}${formatSources(sources)}\n`);
        history.push(
          { role: "user", content: input },
          { role: "assistant", content: answer },
        );
        history = history.slice(-config.historyTurns * 2);
        lastSources = sources;
      }
    } catch (err) {
      console.error(`❌ ${err.message}\n`);
    }
    rl.prompt();
  }

  rl.close();
  console.log("再见 👋");
}

main().catch((err) => {
  console.error(`❌ 启动失败：${err.message}`);
  process.exitCode = 1;
});
