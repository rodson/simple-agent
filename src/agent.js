import { config } from "./config.js";
import { chatStream } from "./ollama.js";
import { search } from "./store.js";

const TOOL_NAME = "search_knowledge_base";

const SYSTEM_PROMPT = [
  "你是一个「个人知识库助手」，只能依据 search_knowledge_base 工具返回的资料回答用户的问题。",
  "规则：",
  "1. 用中文、简洁、直接地回答。",
  "2. 每个事实性结论后标注来源，格式：[来源: 文件名]。示例：我的项目代号是 Kestrel。[来源: about-me.md]",
  "3. 资料不足以回答时，说「知识库中没有相关信息」，绝不凭常识编造。",
  "4. 资料不足或需要更多细节时，可再次调用 search_knowledge_base 换关键词检索。",
  "5. 只回答被问到的问题，不要补充资料里的其他内容，不要复述片段编号。",
].join("\n");

const TOOLS = [
  {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Search the personal knowledge base. 在个人知识库中检索资料，用于查找细节或换关键词补充检索。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query / 检索关键词或完整问题",
          },
        },
        required: ["query"],
      },
    },
  },
];

/** 拼出可直接打印的「参考来源」文本。 */
export function formatSources(sources) {
  if (sources.length === 0) return "";
  const lines = sources.map((item) => {
    const score = item.similarity === null ? "" : `，相似度 ${item.similarity.toFixed(2)}`;
    return `  - ${item.source}（片段 ${item.chunk + 1}${score}）`;
  });
  return `\n参考来源：\n${lines.join("\n")}`;
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 回答一个问题 —— 一个极简的 Agent 循环：
 * 1. Agent 先自己执行一次 search_knowledge_base（不依赖小模型是否主动吐 tool call，保证 RAG 一定生效）。
 * 2. 把工具结果按 Ollama 的 tool 消息格式交给模型；模型可以直接回答，也可以换关键词再调用工具。
 * 3. 最多追加 MAX_TOOL_ROUNDS 轮，之后强制收尾。
 *
 * 每轮都走流式生成，增量通过 onDelta({ type, text, round }) 实时转发给展示层；
 * 返回结构仍是完整的 { answer, sources, thinking }，供调用方收尾与写入历史。
 */
export async function answerOnce(question, history = [], onDelta) {
  const sources = [];
  const thinking = [];
  const collectThinking = (message) => {
    if (typeof message?.thinking === "string" && message.thinking.trim()) {
      thinking.push(message.thinking.trim());
    }
  };
  const collect = (items) => {
    for (const item of items) {
      if (!sources.some((s) => s.source === item.source && s.chunk === item.chunk)) {
        sources.push(item);
      }
    }
    return items;
  };

  const runTool = async (query) => {
    const items = collect(await search(query, config.topK));
    return {
      query,
      results: items.map((item) => ({
        source: item.source,
        chunk: item.chunk,
        text: item.text,
      })),
    };
  };

  const first = await runTool(question);
  if (first.results.length === 0) {
    // 空库直接短路：不给模型留凭常识发挥的机会
    return {
      answer: "知识库中没有相关信息。请先把 .md / .txt 文档放进 docs/，然后执行 npm run ingest。",
      sources: [],
      thinking: [],
    };
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-config.historyTurns * 2),
    { role: "user", content: question },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: TOOL_NAME, arguments: { query: question } } }],
    },
    { role: "tool", tool_name: TOOL_NAME, content: JSON.stringify(first) },
  ];

  for (let round = 0; round < config.maxToolRounds; round++) {
    const message = await chatStream({
      messages,
      tools: TOOLS,
      onDelta: (type, text) => onDelta?.({ type, text, round }),
    });
    collectThinking(message);
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return { answer: message.content?.trim() || "（模型没有返回内容）", sources, thinking };
    }

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = parseArguments(call.function?.arguments);
      let result;
      if (name === TOOL_NAME) {
        result = await runTool(String(args.query || question));
      } else {
        result = { error: `未知工具：${name}` };
      }
      messages.push({
        role: "tool",
        tool_name: name ?? TOOL_NAME, // Ollama 的 chat template 靠它把结果对应回工具调用
        content: JSON.stringify(result),
      });
    }
  }

  // 工具轮数用尽：最后再请求一次，明确禁止继续调用工具
  const finalRound = config.maxToolRounds;
  const final = await chatStream({
    messages: [
      ...messages,
      { role: "user", content: "请直接基于以上资料给出最终答案，不要再调用工具。" },
    ],
    onDelta: (type, text) => onDelta?.({ type, text, round: finalRound }),
  });
  collectThinking(final);
  return { answer: final.content?.trim() || "（模型没有返回内容）", sources, thinking };
}
