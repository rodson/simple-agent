// 测试用的小工具：可断言输出的假 writable、可编排回复的假模型
// @ts-check

/** 收集写入内容的假输出流。 */
export function memoryOut() {
  let text = "";
  return {
    /** @param {string} chunk */
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

/**
 * 按顺序返回预设回复的假 chatStream，并记录每次调用的参数。
 * 回复里的 content / thinking 会像真实流式那样通过 onDelta 推出去。
 * @param {Array<{ content?: string, thinking?: string, tool_calls?: any[] }>} replies
 */
export function fakeChat(replies) {
  /** @type {any[]} */
  const calls = [];
  /** @type {typeof import("../src/core/ollama.js").chatStream} */
  const chat = async (params) => {
    calls.push({ ...params, messages: [...params.messages] });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply.thinking) params.onDelta?.("thinking", reply.thinking);
    if (reply.content) params.onDelta?.("content", reply.content);
    return {
      role: "assistant",
      content: reply.content ?? "",
      thinking: reply.thinking ?? "",
      tool_calls: reply.tool_calls,
    };
  };
  return { chat, calls };
}

/** @param {string} name @param {object | string} [args] 模型给的参数可能是对象或 JSON 字符串 */
export const toolCall = (name, args = {}) => ({ function: { name, arguments: args } });
