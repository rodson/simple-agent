import { createInterface } from "node:readline/promises";
import { config } from "./config.js";
import { answerOnce, formatSources } from "./agent.js";
import { createPrinter } from "./output.js";
import { ingestDocs } from "./ingest.js";
import { resetCollection } from "./store.js";
import { checkAll } from "./doctor.js";

const PROMPT = "你 > ";

const HELP = `
可用命令：
  /ingest   重新导入 docs/ 里的文档（幂等，改过的文件会更新）
  /reset    清空并重建知识库（需要二次确认）
  /sources  显示上一次回答用到的片段
  /thinking 显示/隐藏模型的思考过程
  /clear    清空对话历史
  /help     显示本帮助
  /exit     退出

直接输入自然语言即可提问，例如：我的项目代号是什么？
`;

const WEB_HELP = config.webSearch
  ? `联网搜索：已开启（Tavily）
  本地资料不足或问题涉及时效性信息时，助手会联网检索，每个问题最多 1 次。
  ⚠️ 联网时你输入的问题原文会发送给 Tavily；文档、知识库片段与对话历史不会外发。
  关闭方法：把 .env 中的 WEB_SEARCH 改为 false 后重启。
`
  : `联网搜索：未开启（所有数据只在本机处理）
  开启方法：在 .env 中设置 WEB_SEARCH=true 和 TAVILY_API_KEY 后重启。
`;

async function main() {
  const healthy = await checkAll({ verbose: false });
  if (!healthy) console.log("⚠️  依赖未完全就绪，可运行 npm run doctor 查看细节。\n");

  console.log("本地知识库 Agent（Ollama + Chroma + RAG）");
  console.log(config.webSearch ? "🌐 联网搜索已开启：必要时会把问题原文发送给 Tavily。" : "联网搜索未开启。");
  console.log("输入问题开始提问，/help 查看命令，/exit 退出。\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY), // 管道输入时不输出终端控制字符
  });
  rl.setPrompt(PROMPT);
  rl.on("SIGINT", () => rl.close());

  let history = [];
  let lastSources = [];
  let pendingReset = false;
  let showThinking = config.showThinking;

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
        console.log(HELP + WEB_HELP);
      } else if (input === "/clear") {
        history = [];
        lastSources = [];
        console.log("已清空对话历史。\n");
      } else if (input === "/sources") {
        console.log(
          lastSources.length ? `${formatSources(lastSources).trimStart()}\n` : "还没有参考来源。\n",
        );
      } else if (input === "/thinking") {
        showThinking = !showThinking;
        console.log(`${showThinking ? "已开启" : "已关闭"}思考过程展示。\n`);
      } else if (input === "/ingest") {
        await ingestDocs();
      } else if (input === "/reset") {
        console.log("⚠️  这会清空向量库。确认请输入 y，取消直接回车。");
        pendingReset = true;
      } else {
        console.log("思考中…（模型生成中，请稍候）");
        // 等待期间若 readline 仍在读输入，任何按键都会触发 kRefreshLine() 重绘出
        // "你 > "，看起来像又能提问了，而且输入会被缓冲成下一轮问题。
        rl.pause();
        rl.setPrompt("");
        const printer = createPrinter({ showThinking, answerPrefix: "\n助手 > " });
        try {
          const { answer, sources } = await answerOnce(input, history, printer.onDelta);
          printer.finish({ answer, sources });
          history.push(
            { role: "user", content: input },
            { role: "assistant", content: answer },
          );
          history = history.slice(-config.historyTurns * 2);
          lastSources = sources;
        } finally {
          rl.setPrompt(PROMPT);
          rl.resume();
        }
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
