import { formatSources } from "./agent.js";

/**
 * 把 answerOnce 推来的流式增量实时写到终端，两个 CLI 入口共用。
 * - thinking：惰性打印「思考过程：」标题，逐行缩进，多轮之间空一行；关闭时直接丢弃
 * - content：惰性打印 answerPrefix，然后逐字写出
 * answerPrefix 让 REPL 保留「助手 > 」前缀，而 ask 的 stdout 保持只有答案 + 来源。
 */
export function createPrinter({
  showThinking,
  answerOut = process.stdout,
  thinkingOut = answerOut,
  answerPrefix = "",
}) {
  let thinkingStarted = false;
  let answerStarted = false;
  let lastThinkingRound = -1;
  let afterNotice = false; // 刚打印完提示，光标已在新行开头

  const onDelta = ({ type, text, round }) => {
    if (!text) return;
    if (type === "thinking") {
      if (!showThinking) return;
      if (!thinkingStarted) {
        thinkingOut.write("\n思考过程：\n  ");
        thinkingStarted = true;
      } else if (round !== lastThinkingRound) {
        thinkingOut.write(afterNotice ? "  " : "\n\n  "); // 新一轮工具调用后的思考，空行分隔
      }
      lastThinkingRound = round;
      afterNotice = false;
      thinkingOut.write(text.replace(/\n/g, "\n  "));
    } else if (type === "notice") {
      // 联网状态提示与思考过程同路输出：ask 模式下走 stderr，不污染 stdout 的「回答 + 参考来源」
      const newline = (thinkingStarted || answerStarted) && !afterNotice;
      thinkingOut.write(`${newline ? "\n" : ""}🌐 ${text}\n`);
      afterNotice = true;
    } else if (type === "content") {
      if (!answerStarted) {
        if (thinkingStarted && !afterNotice) thinkingOut.write("\n");
        afterNotice = false;
        answerOut.write(answerPrefix);
        answerStarted = true;
      }
      answerOut.write(text);
    }
  };

  /** 流结束后收尾：补参考来源；模型没吐 content 时兜底打印完整 answer。 */
  const finish = ({ answer, sources }) => {
    const tail = formatSources(sources);
    if (!answerStarted) {
      if (thinkingStarted && !afterNotice) thinkingOut.write("\n");
      answerOut.write(`${answerPrefix}${answer}${tail}\n`);
    } else {
      answerOut.write(`${tail}\n`);
    }
  };

  return { onDelta, finish };
}
