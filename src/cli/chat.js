// @ts-check
import { createInterface } from "node:readline/promises";
import { assertConfig, config } from "../core/config.js";
import { errorMessage, isAbort } from "../core/errors.js";
import { createAgent } from "../core/agent.js";
import { ingestDocs } from "../core/ingest.js";
import { resetCollection } from "../core/store.js";
import { runChecks } from "../core/health.js";
import { createPrinter, formatChecks, formatIngestReport, formatSources } from "./output.js";

/**
 * @typedef {import("../core/ollama.js").ChatMessage} ChatMessage
 * @typedef {import("../core/agent.js").Source} Source
 * @typedef {{ history: ChatMessage[], lastSources: Source[], showThinking: boolean, pendingReset: boolean }} Session
 * @typedef {{ names: string[], help: string, run: (session: Session) => unknown }} Command
 */

const PROMPT = "你 > ";

const WEB_HELP = config.webSearch
  ? `联网搜索：已开启（Tavily）
  本地资料不足或问题涉及时效性信息时，助手会联网检索，每个问题最多 1 次。
  ⚠️ 联网时你输入的问题原文会发送给 Tavily；文档、知识库片段与对话历史不会外发。
  关闭方法：把 .env 中的 WEB_SEARCH 改为 false 后重启。`
  : `联网搜索：未开启（所有数据只在本机处理）
  开启方法：在 .env 中设置 WEB_SEARCH=true 和 TAVILY_API_KEY 后重启。`;

/**
 * 斜杠命令表：新增命令只需加一项，帮助文本自动生成。run 返回 "exit" 表示退出。
 * @type {Command[]}
 */
const COMMANDS = [
  {
    names: ["/ingest"],
    help: "重新导入文档（幂等，改过的文件会更新，删掉的文件会移除）",
    run: async () => {
      const report = await ingestDocs({ onFile: (source, chunks) => console.log(`  ${source} → ${chunks} 个片段`) });
      console.log(`${formatIngestReport(report)}\n`);
    },
  },
  {
    names: ["/reset"],
    help: "清空并重建知识库（需要二次确认）",
    run: (session) => {
      console.log("⚠️  这会清空向量库。确认请输入 y，取消直接回车。");
      session.pendingReset = true;
    },
  },
  {
    names: ["/sources"],
    help: "显示上一次回答用到的片段",
    run: ({ lastSources }) =>
      console.log(lastSources.length ? `${formatSources(lastSources).trimStart()}\n` : "还没有参考来源。\n"),
  },
  {
    names: ["/thinking"],
    help: "显示/隐藏模型的思考过程",
    run: (session) => {
      session.showThinking = !session.showThinking;
      console.log(`${session.showThinking ? "已开启" : "已关闭"}思考过程展示。\n`);
    },
  },
  {
    names: ["/clear"],
    help: "清空对话历史",
    run: (session) => {
      session.history = [];
      session.lastSources = [];
      console.log("已清空对话历史。\n");
    },
  },
  { names: ["/help"], help: "显示本帮助", run: () => console.log(helpText()) },
  { names: ["/exit", "/quit"], help: "退出", run: () => "exit" },
];

function helpText() {
  const rows = COMMANDS.map(({ names, help }) => `  ${names.join(" / ").padEnd(16)}${help}`);
  return [
    "",
    "可用命令：",
    ...rows,
    "",
    "直接输入自然语言即可提问，例如：我的项目代号是什么？",
    "回答生成过程中按 Ctrl+C 可中止本次回答。",
    "",
    WEB_HELP,
    "",
  ].join("\n");
}

/**
 * 生成回答期间接管键盘：暂时摘掉 readline 的按键监听，只响应 Ctrl+C（中止本次回答），
 * 其余按键直接丢弃 —— 否则按键会触发 readline 重绘出「你 > 」，并被缓冲成下一轮问题。
 * 返回恢复函数。管道输入（非 TTY）时没有按键事件，退化为暂停 readline。
 * @param {import("node:readline/promises").Interface} rl
 * @param {() => void} onCancel
 */
function captureKeys(rl, onCancel) {
  rl.setPrompt("");
  if (!process.stdin.isTTY) {
    rl.pause();
    return () => {
      rl.setPrompt(PROMPT);
      rl.resume();
    };
  }
  const saved = process.stdin.listeners("keypress");
  process.stdin.removeAllListeners("keypress");
  /** @param {string} _ @param {{ ctrl?: boolean, name?: string } | undefined} key */
  const onKey = (_, key) => {
    if (key?.ctrl && key.name === "c") onCancel();
  };
  process.stdin.on("keypress", onKey);
  return () => {
    process.stdin.off("keypress", onKey);
    for (const listener of saved) process.stdin.on("keypress", /** @type {(...args: any[]) => void} */ (listener));
    rl.setPrompt(PROMPT);
  };
}

/**
 * @param {ReturnType<typeof createAgent>} agent
 * @param {import("node:readline/promises").Interface} rl
 * @param {Session} session
 * @param {string} question
 */
async function ask(agent, rl, session, question) {
  console.log("思考中…（模型生成中，请稍候；Ctrl+C 中止）");
  const controller = new AbortController();
  const restore = captureKeys(rl, () => controller.abort());
  const printer = createPrinter({ showThinking: session.showThinking, answerPrefix: "\n助手 > " });
  try {
    const result = await agent.answer(question, {
      history: session.history,
      onDelta: printer.onDelta,
      signal: controller.signal,
    });
    printer.finish(result);
    // 对话历史只在这里截断，Agent 不再关心保留几轮
    session.history = [
      ...session.history,
      { role: /** @type {const} */ ("user"), content: question },
      { role: /** @type {const} */ ("assistant"), content: result.answer },
    ].slice(-config.historyTurns * 2);
    session.lastSources = result.sources;
  } catch (err) {
    if (!isAbort(err)) throw err;
    console.log("\n\n⏹  已中止本次回答（不会写入对话历史）。");
  } finally {
    restore();
    console.log();
  }
}

async function main() {
  assertConfig();
  const checks = await runChecks();
  if (!checks.every((check) => check.ok)) {
    console.log(
      `${formatChecks(checks.filter((check) => !check.ok))}\n⚠️  依赖未完全就绪，可运行 npm run doctor 查看细节。\n`,
    );
  }

  console.log("本地知识库 Agent（Ollama + Chroma + RAG）");
  console.log(config.webSearch ? "🌐 联网搜索已开启：必要时会把问题原文发送给 Tavily。" : "联网搜索未开启。");
  console.log("输入问题开始提问，/help 查看命令，/exit 退出。\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY), // 管道输入时不输出终端控制字符
  });
  rl.setPrompt(PROMPT);
  rl.on("SIGINT", () => rl.close()); // 在提示符下按 Ctrl+C 退出

  const agent = createAgent();
  /** @type {Session} */
  const session = { history: [], lastSources: [], showThinking: config.showThinking, pendingReset: false };
  const commandByName = new Map(COMMANDS.flatMap((command) => command.names.map((name) => [name, command])));

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    try {
      if (session.pendingReset) {
        session.pendingReset = false;
        if (input === "y" || input === "yes") {
          await resetCollection();
          console.log("已清空知识库。请执行 /ingest 重新导入。\n");
        } else {
          console.log("已取消。\n");
        }
      } else if (input.startsWith("/")) {
        const command = commandByName.get(input);
        if (!command) console.log(`未知命令 ${input}，输入 /help 查看可用命令。\n`);
        else if ((await command.run(session)) === "exit") break;
      } else if (input) {
        await ask(agent, rl, session, input);
      }
    } catch (err) {
      console.error(`❌ ${errorMessage(err)}\n`);
    }
    rl.prompt();
  }

  rl.close();
  console.log("再见 👋");
}

main().catch((err) => {
  console.error(`❌ 启动失败：${errorMessage(err)}`);
  process.exitCode = 1;
});
