// @ts-check

/**
 * @typedef {import("../core/agent.js").Source} Source
 * @typedef {import("../core/agent.js").AgentEvent} AgentEvent
 * @typedef {{ write(text: string): unknown }} Writable
 */

/**
 * 拼出可直接打印的「参考来源」文本。
 * 只有本次确实用到网络来源时，才给每条加上 [本地] / [网络] 标签。
 * @param {Source[]} sources
 */
export function formatSources(sources) {
  if (sources.length === 0) return "";
  const labeled = sources.some((item) => item.kind === "web");
  const lines = sources.map((item) => {
    if (item.kind === "web") return `  - [网络] ${item.title} ${item.url}`;
    const score = item.similarity === null ? "" : `，相似度 ${item.similarity.toFixed(2)}`;
    return `  - ${labeled ? "[本地] " : ""}${item.source}（片段 ${item.chunk + 1}${score}）`;
  });
  return `\n参考来源：\n${lines.join("\n")}`;
}

/**
 * 把 Agent 推来的流式增量实时写到终端，两个 CLI 入口共用。
 * - thinking：惰性打印「思考过程：」标题，逐行缩进，多轮之间空一行；关闭时直接丢弃
 * - notice：状态提示（联网、工具失败），与思考过程同路输出
 * - content：惰性打印 answerPrefix，然后逐字写出；不同轮的 content 之间空一行，
 *   与 Agent 拼接最终答案的方式一致
 * answerPrefix 让 REPL 保留「助手 > 」前缀，而 ask 的 stdout 保持只有答案 + 来源。
 * @param {{ showThinking: boolean, answerOut?: Writable, thinkingOut?: Writable, answerPrefix?: string }} options
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
  let lastContentRound = -1;
  let afterNotice = false; // 刚打印完提示，光标已在新行开头

  /** @param {AgentEvent} event */
  const onDelta = (event) => {
    if (!event.text) return;
    if (event.type === "notice") {
      // ask 模式下走 stderr，不污染 stdout 的「回答 + 参考来源」
      const newline = (thinkingStarted || answerStarted) && !afterNotice;
      thinkingOut.write(`${newline ? "\n" : ""}${event.text}\n`);
      afterNotice = true;
      return;
    }

    const { type, text, round } = event;
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
      return;
    }

    if (!answerStarted) {
      if (thinkingStarted && !afterNotice) thinkingOut.write("\n");
      answerOut.write(answerPrefix);
      answerStarted = true;
    } else if (round !== lastContentRound) {
      answerOut.write(afterNotice ? "\n" : "\n\n");
    }
    afterNotice = false;
    lastContentRound = round;
    answerOut.write(text);
  };

  /**
   * 流结束后收尾：补参考来源；模型没吐 content 时兜底打印完整 answer。
   * @param {{ answer: string, sources: Source[] }} result
   */
  const finish = ({ answer, sources }) => {
    const tail = formatSources(sources);
    if (answerStarted) {
      answerOut.write(`${tail}\n`);
      return;
    }
    if (thinkingStarted && !afterNotice) thinkingOut.write("\n");
    answerOut.write(`${answerPrefix}${answer}${tail}\n`);
  };

  return { onDelta, finish };
}

/**
 * 把导入报告转成给人看的文字（逐个文件的进度由 onFile 实时打印，这里只做汇总）。
 * @param {import("../core/ingest.js").IngestReport} report
 */
export function formatIngestReport(report) {
  const lines = report.tooLarge.map((source) => `  跳过超大文件（>2MB）：${source}`);
  if (report.missingDir) {
    lines.push(
      `⚠️  文档目录 ${report.docsDir} 不存在，${report.reset ? "知识库已清空，但没有导入任何文档" : "未做任何改动"}（集合现有 ${report.total} 个片段）。`,
    );
    return lines.join("\n");
  }
  for (const source of report.removedSources) lines.push(`  ${source} → 已从知识库移除（文件已删除或超过大小限制）`);
  if (report.updated.length === 0 && report.unchanged === 0) {
    lines.push(`⚠️  ${report.docsDir} 里没有找到 .md / .markdown / .txt 文档。`);
  }
  lines.push(
    `✅ 更新 ${report.updated.length} 个文件，${report.unchanged} 个未变化已跳过，` +
      `移除 ${report.removedSources.length} 个（集合现有 ${report.total} 个片段）`,
  );
  return lines.join("\n");
}

/**
 * 把体检结果转成多行文字。
 * @param {import("../core/health.js").Check[]} checks
 */
export function formatChecks(checks) {
  return checks
    .map(({ ok, label, hint }) => {
      const head = `${ok ? "✅" : "❌"} ${label}`;
      return hint ? `${head}\n   → ${hint.replace(/\n/g, "\n   → ")}` : head;
    })
    .join("\n");
}
