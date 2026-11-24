# 契约：命令行与配置

**关联**：[plan.md](../plan.md) / [quickstart.md](../quickstart.md)

## 配置项契约

| 名称 | 默认值 | 类型 | 含义 |
|---|---|---|---|
| `WEB_SEARCH` | `false` | 布尔 | 是否允许本进程发起对外检索；关闭时不得有任何对外请求 |
| `WEB_SEARCH_ENDPOINT` | `https://html.duckduckgo.com/html/` | 字符串 | 公开检索端点，可指向自建兼容镜像或不可达地址用于验收 |

- 沿用 `src/config.js` 的 `.env` 读取规则：系统环境变量优先于 `.env`，没有 `.env` 时用默认值。
- 布尔值解析与报错沿用既有 `booleanFlag`；端点非法时按配置错误在启动阶段暴露，不静默降级。
- 两个配置项**必须**同步写入 `.env.example` 与 `README.md` 的配置表（宪法原则二）。

## 输出契约（不变量）

- `npm run ask` 的标准输出只含「回答 + 参考来源」；思考过程只能写到标准错误输出；
  错误写标准错误输出并以非零退出码结束。
- `WEB_SEARCH=false` 时，回答与「参考来源」的格式与现状**逐字一致**，不出现 `[本地]` / `[网络]` 标签。
- 仅当本次回答确实包含网络来源时才启用标签：

```text
参考来源：
  - [本地] about-me.md（片段 1，相似度 0.82）
  - [网络] Node.js 官网 https://nodejs.org/
```

- 网络条目必须给出标题与完整可打开的网址（FR-005、SC-004）；本地条目格式保持不变。
- 联网失败提示不进入 `npm run ask` 的标准输出：交互模式显示在界面上，一次性提问写到标准错误输出，
  不污染脚本可消费的输出（FR-009、FR-011）。
- 交互模式 `/sources` 复用同一来源集合与格式，必须能再次看到网络来源（FR-013）。
- 交互模式 `/help` 必须说明：开关是否启用、何时会对外访问、哪些数据会外发，
  并提示用户输入的提问文本会离开本机（FR-007）。

## 兼容性契约

- `npm start`、`npm run ask`、`npm run doctor`、`npm run ingest`、`npm run reset`、
  `/ingest`、`/reset`、`/clear`、`/thinking`、`/exit` 的行为不变。
- 关闭联网时 `MAX_TOOL_ROUNDS`、`HISTORY_TURNS`、`SHOW_THINKING`、`TOP_K` 等既有配置语义不变。
- 不新增斜杠命令、不新增命令参数、不新增 npm 脚本。
