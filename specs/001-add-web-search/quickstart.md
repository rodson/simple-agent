# 验收指引：联网搜索

**关联**：[plan.md](plan.md) / [contracts/cli.md](contracts/cli.md) / [contracts/web-search.md](contracts/web-search.md)

> 本指引只给出可复现的命令与预期结果，不含实现代码。命令不改动 `docs/`；空库场景使用独立集合，
> 不影响个人知识库 `personal_kb`。

## 前置条件

- Node.js ≥ 22；`ollama serve` 已运行；另开终端保持 `npm run chroma` 运行。
- `npm run doctor` 通过；已执行过 `npm run ingest`。
- 涉及真实联网的场景需要可用网络；场景 1、3 可完全离线执行。

## 场景 1：默认关闭零回归（宪法质量门禁）

```bash
WEB_SEARCH=false WEB_SEARCH_ENDPOINT=http://127.0.0.1:9/ npm run ask -- "我的项目代号是什么？" > /tmp/kb-answer.txt
```

**预期**：立即得到原有回答；`/tmp/kb-answer.txt` 只有「回答 + 参考来源」，没有 `[网络]` / `[本地]` 标签；
即使端点指向不可达地址也无任何等待或提示，说明关闭状态下没有对外请求。

## 场景 2：端点可用性与网络来源（FR-004 / FR-005 / SC-001 / SC-004）

```bash
WEB_SEARCH=true npm run ask -- "Node.js 当前最新的 LTS 版本是什么？"
```

**预期**：回答中出现可打开核验的网址；「参考来源」含 `[网络]` 标签与标题；
若同时用到本地片段，还会出现 `[本地]` 标签，两类不混淆。

**若出现「联网检索未成功」**：说明默认端点不可用、被限流或已改版。按
[research.md](research.md) 决策 1 的风险条目排查，或用 `WEB_SEARCH_ENDPOINT` 指向自建兼容镜像；
此时本地问答仍应正常，不得报错退出。

## 场景 3：断网降级与输出纯净（FR-009 / FR-011 / SC-002）

```bash
WEB_SEARCH=true WEB_SEARCH_ENDPOINT=http://127.0.0.1:9/ npm run ask -- "我的项目代号是什么？" > /tmp/kb-fallback.txt 2> /tmp/kb-fallback.err
```

**预期**：10 秒内结束；给出明确提示但仍返回基于本地文档的答案；
`/tmp/kb-fallback.txt` 不含提示文字，提示出现在 `/tmp/kb-fallback.err`（或交互界面）；退出码正常。

> 需要验证 10 秒上限时，把端点指向一个故意不响应的本地地址，确认不会无限等待。

## 场景 4：空知识库 + 联网开启（原则三修订后的例外）

```bash
COLLECTION=web_smoke WEB_SEARCH=true npm run ask -- "今天 Node.js 的最新 LTS 版本是什么？"
```

**预期**：本地集合为空，仍给出带 `[网络]` 来源的回答，不出现「知识库中没有相关信息」。
`COLLECTION=web_smoke` 会创建一个空集合，不影响 `personal_kb`；如需清理可执行
`COLLECTION=web_smoke npm run reset`。

## 场景 5：交互模式、来源复查与 `/help`（FR-007 / FR-013）

```bash
WEB_SEARCH=true npm start
```

**预期**：`/help` 说明开关、对外访问时机与外发数据范围；提问后回答末尾同时列出两类来源；
紧接着执行 `/sources` 能再次看到同样的网络来源；`/thinking`、`/clear` 行为不变。

## 提交前人工验收清单（宪法「开发流程与质量门禁」）

- `npm run doctor` 通过；`npm run ingest` 重复执行无重复片段；
  `npm run ask -- "问题"` 的回答附带来源且标准输出无思考过程；`/help`、`/sources`、`/thinking` 可用。
- `package.json` 未新增运行时依赖；仓库中无密钥；默认配置下零对外请求。
- 开启联网时仅发送当前提问派生的检索词；网络结果未写入知识库；导入与重置行为未变。
- 场景 1～5 全部通过；本次新增或修改的文档与工件全为中文、无中英混杂。
