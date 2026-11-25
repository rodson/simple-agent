# 本地个人知识库 Agent（带 RAG）

一个**可以完全跑在自己电脑上**的最小知识库问答 Agent：把 `.md` / `.txt` 放进 `docs/`，导入后就能用中文提问，回答会附上来源片段。

- **Ollama**：本地大模型 + 本地 embedding，数据不出本机
- **流式输出**：`/api/chat` 的 NDJSON 增量逐字显示，思考过程与回答边生成边出现
- **Chroma**：本地向量库，数据存在 `./chroma-data/`
- **Node.js**：只用内置 `fetch` / `readline` / `crypto`，唯一第三方依赖是 `chromadb`
- **不需要 Docker、不需要 Python、不需要云服务、不需要 API Key**
- **可选联网搜索**：默认关闭；开启后由 [Tavily](https://tavily.com) 补充时效性信息，来源标注网址（需要 API Key，详见[联网搜索](#联网搜索可选)）

```
docs/*.md|txt ──切块──> Ollama /api/embed ──> Chroma 持久化
                                                  │
用户提问 ──> Ollama /api/embed ──> Chroma 检索 ───┘
                                      │
             检索片段 + 问题 ──> Ollama /api/chat(tools) ──> 带来源的回答
                                      ↑                    │
                                      └── 可换关键词追加检索 ─┘  (Agent 循环)
```

## 快速开始

前置条件：**Node.js ≥ 22**、[Ollama](https://ollama.com/download) 已安装并运行（`ollama serve`）。

```bash
# 1. 安装依赖
npm install

# 2. 下载模型（首次约 8–9GB：qwen3.5:9b 6.6–7.6GB + bge-m3 约 1.2GB）
npm run models

# 3. 另开一个终端启动 Chroma（保持窗口不关）
npm run chroma

# 4. 把自己的 .md / .txt 放进 docs/（仓库自带两份示例文档）
#    然后导入，可重复执行：只处理新增或改过的文件，没变的直接跳过
npm run ingest

# 5. 开始对话
npm start
```

一次性提问（适合脚本调用）：

```bash
npm run ask -- "我的项目代号是什么？"
```

`npm run ask` 的 stdout 只有「回答 + 参考来源」（流式逐字写出，重定向到文件仍是完整答案），默认不输出思考过程；需要时用 `SHOW_THINKING=true npm run ask -- "问题"`，思考过程会打印到 stderr。

启动前体检：

```bash
npm run doctor
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run chroma` | 启动本地 Chroma 服务（`127.0.0.1:8000`） |
| `npm run models` | 拉取对话模型与向量模型 |
| `npm run doctor` | 检查 Ollama / 模型 / Chroma / 集合状态 |
| `npm run ingest` | 增量导入 `docs/` 下的文档 |
| `npm run reset` | 删除集合并重建（切换向量模型后必须使用） |
| `npm start` | 进入交互式对话 |
| `npm run ask -- "问题"` | 单次提问并退出 |
| `npm test` | 运行单元测试（不需要 Ollama / Chroma） |

对话中的斜杠命令（`/help` 会同时显示联网搜索是否开启）：`/ingest`、`/reset`（二次确认）、`/sources`（上次回答用到的片段）、`/thinking`（显示/隐藏思考过程）、`/clear`、`/help`、`/exit`。

## 配置

复制 `.env.example` 为 `.env` 后按需修改；`src/config.js` 用 Node 内置的 `process.loadEnvFile()` 读取它，没有 `.env` 也能用默认值启动，系统环境变量优先级更高。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 地址 |
| `CHAT_MODEL` | `qwen3.5:9b` | 对话模型，需支持 tool calling；9B 更吃内存/显存，资源紧张可换 `qwen3.5:4b` |
| `EMBED_MODEL` | `bge-m3` | 向量模型，支持 100+ 语言；更轻量可选 `nomic-embed-text` |
| `CHROMA_HOST` / `CHROMA_PORT` | `127.0.0.1` / `8000` | Chroma 地址 |
| `COLLECTION` | `personal_kb` | 集合名 |
| `TOP_K` | `4` | 每次检索返回的片段数 |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `512` / `60` | 切块字符数与重叠字符数 |
| `MAX_TOOL_ROUNDS` | `5` | Agent 最多追加检索几轮 |
| `HISTORY_TURNS` | `7` | 保留的对话轮数 |
| `SHOW_THINKING` | `true` | 交互式对话是否展示思考过程（`/thinking` 可临时切换）；`npm run ask` 默认不展示 |
| `WEB_SEARCH` | `false` | 是否开启联网搜索，详见下一节 |
| `TAVILY_API_KEY` | 空 | Tavily 密钥，开启 `WEB_SEARCH` 时必填 |
| `DOCS_DIR` | `docs` | 文档目录 |

> 修改端口时不必改 `package.json`：启动服务用 `CHROMA_PORT=8123 npm run chroma`，同时在 `.env` 里写 `CHROMA_PORT=8123` 让 Node 端连到同一端口（`.env` 不会自动注入到 `chroma` 这个 shell 脚本）。

## 联网搜索（可选）

默认关闭，关闭时不会发生任何对外请求，行为与纯本地版本完全一致。开启方法：

1. 在 [app.tavily.com](https://app.tavily.com) 免费注册并获取 API Key（`tvly-` 开头，免费额度足够个人使用）。
2. 在 `.env` 中写入：

   ```bash
   WEB_SEARCH=true
   TAVILY_API_KEY=tvly-xxxxxxxx
   ```

3. 重启 `npm start` 或直接 `npm run ask -- "Node.js 当前最新的 LTS 版本是什么？"`。

工作方式与边界：

- **何时联网**：本地知识库仍是每次必查的第一步。模型认为本地资料不足或问题涉及时效性信息时会调用 `search_web` 工具；本地知识库为空时 Agent 会直接兜底检索一次。
- **外发什么**：只发送你当前输入的**问题原文**（Agent 忽略模型给出的任何关键词，防止知识库片段或对话历史被拼进外发请求）。文档、知识库片段、配置与对话历史都不会外发。如果问题本身含隐私信息，请不要在开启联网时提问。
- **限制**：每个问题最多联网 1 次、最多取 5 条结果、等待上限 10 秒。
- **失败降级**：断网、超时、密钥无效、限流或零结果时会提示「联网检索未成功」，然后继续按本地知识库作答；`npm run ask` 下提示写到 stderr，stdout 仍只有「回答 + 参考来源」。
- **来源区分**：本次回答用到网络结果时，「参考来源」会加 `[本地]` / `[网络]` 标签，网络条目附标题与网址；没用到时输出格式与原来逐字一致。`/sources` 同样能看到网络来源。
- **不入库**：网络结果只在当次回答中使用，不写入 Chroma、不落盘，不影响 `ingest` / `reset`。
- **不可信资料**：网页摘要中的指令性文字只被当作普通资料，模型被要求不得照做；本地资料与网络结果冲突时以本地为准。

> 为什么用 Tavily 而不是免密钥的网页抓取：实测 DuckDuckGo、百度会拦截脚本请求，Bing 会对脚本请求返回与查询无关的随机结果，都不可靠。

## 目录结构

```
.
├── package.json        # 依赖与 npm scripts
├── .env.example        # 配置样例
├── docs/               # 放你自己的 .md / .txt（支持子目录）
├── chroma-data/        # Chroma 持久化数据（自动生成，已 gitignore）
└── src/
    ├── config.js       # 环境变量与默认值
    ├── ollama.js       # /api/embed、/api/chat(流式 NDJSON)、/api/tags
    ├── store.js        # Chroma 集合、写入、向量检索、清理
    ├── ingest.js       # 扫描文档、切块、增量导入
    ├── websearch.js    # 可选联网搜索（Tavily），唯一发起外部请求的模块
    ├── agent.js        # 系统提示词 + 工具调用循环 + RAG 兜底
    ├── output.js       # 流式增量输出：思考过程缩进、回答前缀、来源收尾
    ├── chat.js         # 交互式 REPL
    ├── ask.js          # 单次提问
    └── doctor.js       # 依赖体检
└── test/               # 纯函数单元测试（node:test，零依赖）
```

## 推荐阅读顺序

想弄懂这个 Agent 是怎么工作的，按下面的顺序读源码即可，每个文件都不长：

1. [src/config.js](src/config.js)：所有可配置项和默认值
2. [src/ollama.js](src/ollama.js)：怎么调用本地模型，算向量、流式对话
3. [src/store.js](src/store.js)：怎么把向量存进 Chroma、怎么做相似度检索
4. [src/ingest.js](src/ingest.js)：文档怎么被切块并导入知识库
5. [src/agent.js](src/agent.js)：**核心**，工具定义和 Agent 循环（检索 → 模型回答或继续调用工具 → 收尾）
6. [src/output.js](src/output.js)、[src/chat.js](src/chat.js)、[src/ask.js](src/ask.js)：把流式结果展示到终端
7. [test/basics.test.js](test/basics.test.js)：纯函数的用法示例

## 实现要点

- **为什么显式传向量**：`chromadb@3.x` 的默认 embedding function 依赖额外 ONNX 包，且不再内置 Ollama 版本。本项目自己调 `/api/embed`，把 `embeddings` / `queryEmbeddings` 直接传给 Chroma，集合以 `embeddingFunction: null` 创建。
- **Agent 循环怎么工作**：Agent 先确定性地执行一次 `search_knowledge_base`，把结果按 Ollama 的 `role:"tool"` 格式交给模型；模型可以直接回答，也可以换关键词再次调用工具，最多 `MAX_TOOL_ROUNDS` 轮。即使模型支持 tool calling，也不能保证每次都会主动发起调用，所以第一步由 Agent 自己执行 —— 既保证 RAG 一定生效，又保留模型自主追加检索的能力；`qwen3.5:9b` 这类更擅长工具调用的模型会更频繁地触发后续工具调用。工具集中定义在 `createTools()` 里，每个工具都由 `description` / `parameters`（交给模型）和 `run(args)`（由 Agent 执行）组成，新增工具只需往里加一项，循环本身不用改。工具结果消息带 `tool_name` 以兼容 Ollama 的 chat template；空库时直接短路返回，不调用模型。
- **流式输出怎么工作**：`src/ollama.js` 的 `chatStream()` 把 `/api/chat` 的 `stream: true` 响应当作 NDJSON 逐帧解析，`message.thinking` / `message.content` 都是增量片段，`tool_calls` 在流末尾一次性给出（实测工具调用轮的 `content` 为空）。它边解析边用 `onDelta()` 把增量推给 `src/output.js` 的 printer，同时累积出完整 message 供 Agent 判断是否需要继续调用工具；`answerOnce()` 仍返回完整的 `{ answer, sources, thinking }`，CLI 只在流结束后补印「参考来源」。`npm run ask` 用同一个 printer，但思考过程写到 stderr、stdout 保持只有答案。
- **qwen3.5 的 thinking**：Ollama 会把推理文本放在 `message.thinking`，`answerOnce()` 汇总 Agent 各轮（含工具调用轮与最终收尾轮）的 thinking，printer 在回答前以「思考过程」块逐字输出，多轮之间空一行；它不会混进 `content`，也不会写入对话历史。交互式对话默认展示，可用 `SHOW_THINKING=false` 或会话内 `/thinking` 关闭；`npm run ask` 为保持 stdout 干净默认不展示，显式设 `SHOW_THINKING=true` 时思考过程输出到 stderr。换用不返回 `message.thinking` 的模型时不会出现该块（本项目不解析 content 里的 `<think>` 标签）；如需降低延迟可在 `src/ollama.js` 的 `/api/chat` 请求体里加 `think: false`（实测工具调用仍正常）。
- **增量导入**：片段 ID = `相对路径#序号`，每个片段的元数据里记着所属文件的内容哈希（含切块参数）。导入时哈希没变的文件直接跳过；变了的文件先写入新片段，全部成功后再删除多余的旧片段，中途失败也不会把知识库删空；磁盘上已删除的文件也会从库中清掉。
- **引用兜底**：即使模型漏标 `[来源: xxx]`，CLI 也会独立打印「参考来源」列表。

## 常见问题

**Q：提问后为什么迟迟没有回答，连 `你 > ` 也不见了？**
A：本地 9B 模型生成回答（尤其带 thinking）可能要几十秒到几分钟，期间 CLI 会暂停输入、隐藏提示符，只显示「思考中…（模型生成中，请稍候）」；回答完成后 `你 > ` 会重新出现，等待期间不必重复按回车。可用 `ollama ps` 确认模型正在推理；若想少等，可在 `src/ollama.js` 的 `/api/chat` 请求体里加 `think: false`。

**Q：换 embedding 模型后报错「向量维度不匹配」？**
A：不同模型向量维度不同。执行 `npm run reset && npm run ingest` 重建即可；程序也会在发现集合的 `embed_model` 与当前配置不一致时主动提示。

**Q：只换对话模型（如改成 `qwen3.5:9b`）需要重建知识库吗？**
A：不需要。`CHAT_MODEL` 只影响回答生成，向量仍由 `EMBED_MODEL` 产生；拉取新模型并确认 `npm run doctor` 通过即可直接提问。

**Q：提示无法连接 Chroma？**
A：`npm run chroma` 需要在一个独立终端里持续运行，它是本地服务而不是一次性命令。

**Q：提示 Ollama 里没有模型？**
A：执行 `npm run models`，或手动 `ollama pull qwen3.5:9b && ollama pull bge-m3`。可用 `ollama list` 确认。

**Q：回答「知识库中没有相关信息」但文档里明明有？**
A：先试 `npm run ask -- "<更贴近原文措辞的问题>"`；仍不行就调小 `CHUNK_SIZE`、增大 `TOP_K`，重新 `npm run ingest`。

**Q：支持 PDF / Word 吗？**
A：目前只支持 `.md` / `.markdown` / `.txt`，保持依赖最小。要加 PDF，只需在 `scanDocs()` 里解析出纯文本后复用 `chunkFile()` 即可。

## 可扩展方向（本仓库刻意未实现）

Web UI · 重排序 / 混合检索 · PDF 解析 · 多用户与鉴权 · Docker Compose · 网页正文抓取 / 搜索结果缓存。
