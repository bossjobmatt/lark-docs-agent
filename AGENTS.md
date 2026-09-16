# AGENTS.md — AI 编码代理工作指引

本文件指导 AI 代理在本仓库中工作。改动前请先读完本文件；它记录了架构、约定与已踩过的坑。

## 项目是什么

**Lark 文档助手（本地演示）**：本地 Web 服务，用户粘贴飞书/Lark 文档链接 + 问题，AI Agent 调用**本地已认证的 lark CLI** 读取文档后回答。定位与边界务必遵守：

- 本项目是 lark CLI 的**纯调用方**——不做其安装、认证、凭据管理，也不实现/内置默认 CLI（`fixtures/lark-demo/lark` 仅为显式启用的演示 mock）。完整边界见 `README.md` 的「职责边界」一节。
- LLM 凭据通过界面配置（`data/llm-config.json`，明文 Key，已被 gitignore，**绝不提交**）。

## 硬性约束

- **Node >= 18，原生 `http` 模块，零 Web 框架**。不要引入 Express/TypeScript/构建链。
- **前端零依赖、静态文件直出**（`public/`）：不要给前端加 npm 包或打包步骤；Markdown 渲染与消毒都在服务端（`src/markdown.js`）。
- **运行依赖仅三个**：`marked`、`@earendil-works/pi-coding-agent`、`typebox`。新增依赖需要充分理由。

## 常用命令

```bash
npm start          # 启动服务（127.0.0.1:3737）
npm run dev        # node --watch 开发模式
npm run demo       # 演示模式：以内置模拟 CLI 跑通全链路（无需任何真实凭据）
npm test           # node --test 测试套件（22 用例，含 spawn 服务的 HTTP e2e）
npm run lark -- doc list   # 直接调用演示 mock CLI
```

## 架构地图（src/）

| 模块 | 接口 | 职责 |
| --- | --- | --- |
| `server.js` | HTTP 路由 | 纯分发器：15 个内联分支，勿引入路由框架 |
| `agent.js` | `handle(message, session, {onEvent, signal})` | 编排：链接提取 → 文档缓存 → 上下文组装（预算/选段）→ LLM/模拟回答；降级链 pi→builtin→sim |
| `pi-agent.js` | `run/dispose/isAvailable/syncConfig` | pi SDK 适配：常驻 AgentSession 池（上限 50 FIFO）、SDK 事件转发 |
| `llm-config.js` | 配置管理 | 界面保存 > 环境变量 > 默认；打码；`applyPatch` 共享归一化 |
| `llm.js` | `chat/chatStream/test/listModels` | OpenAI 兼容客户端：chat 与 responses 两种 SSE 解析共享 `buildRequest` |
| `store.js` | `getOrCreate/appendMessages/cacheDoc/setTitle/...` | 会话存储：**拥有全部变更与持久化**；TTL/总量/截断淘汰 |
| `protocol.js` | 事件工厂 + `makeReply` | 流式事件与回复对象的**唯一契约** |
| `lark.js` | `runLarkCli/cliStatus` | lark CLI 纯调用：三级解析（LARK_CLI → PATH 探测认证 → 无） |
| `markdown.js` | `renderMarkdown` | marked + 轻量消毒（去 script/iframe/内联事件） |

## 关键约定（改动前必读）

1. **store 拥有变更与落盘**：任何对会话的写操作必须走 store 方法（`appendMessages`/`cacheDoc`/`setTitle`），**调用者不碰 `persist`、不直接改 session 字段**。
2. **流式事件契约只在 `protocol.js`**：五种事件 `start/tool/delta/done/error`。新增事件类型只改 protocol.js + `public/app.js`（前端为文档化消费者），不许在其他文件手拼事件对象。
3. **lark CLI 信封约定**：`{ code, msg, data }`，code 0 成功；子命令 `auth status` / `doc list` / `doc get <url|token>` / `doc search <kw>`。未检测到 CLI 时返回友好引导信封（不执行任何命令）。
4. **上下文预算**：LLM 输入受 `CONTEXT_BUDGET_CHARS`（默认 24000 字符）约束；超 `DOC_FULL_TEXT_MAX`（8000）的文档按问题节选 top-k 章节 + 大纲；超限类错误先裁剪最早缓存文档自愈一次。
5. **落盘瘦身**：sessions.json 为紧凑 JSON，仅存 Markdown 原文——**html 渲染结果不落盘**（加载时现算），**docs 文档缓存只在内存**。新增字段要考虑是否落盘。

## 测试

- 框架：Node 原生 `node --test`，**零测试依赖**。每个测试文件是独立进程，因此可以在 `require` 模块**之前**注入环境变量（`SESSIONS_FILE` / `LLM_CONFIG_FILE` / `SESSION_TTL_DAYS` 等）指向临时文件。
- ⚠️ **坑**：`node --test` 默认发现会匹配 `test/**/*.js`——**任何**放进 `test/` 的 .js 都会被当作测试执行。辅助 fixture 必须放在根级 `fixtures/`（如 `fixtures/mock-openai.js` 模拟网关、`fixtures/lark-demo/` 演示 mock CLI）。
- 测试断言行为而非实现：改实现不需要改测试；若改测试才能过，先想清楚是不是在测内部细节。
- 验证链路用 mock：`test/http.e2e.test.js` spawn `fixtures/mock-openai.js`（模拟 OpenAI 兼容网关，含流式与工具调用流程）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | 3737 / 127.0.0.1 | 监听地址 |
| `LARK_CLI` | 未设置 | 显式指定 lark CLI 路径；未设则探测 PATH |
| `SESSIONS_FILE` / `LLM_CONFIG_FILE` | `data/` 下 | **测试用**落盘覆盖 |
| `SESSION_TTL_DAYS` / `SESSION_MAX_COUNT` / `SESSION_MAX_MESSAGES` | 7 / 100 / 50 | 会话淘汰（显式 0 生效） |
| `CONTEXT_BUDGET_CHARS` / `DOC_FULL_TEXT_MAX` | 24000 / 8000 | LLM 上下文预算 |
| `AGENT_MODE` | `pi` | 默认 Agent 模式（显式 `builtin` 切回） |
| `PI_AGENT_DIR` / `PI_PROMPT_TIMEOUT_MS` | `data/pi-agent/` / 120000 | pi 模式 |
| `LARK_FAIL_RATE` | 0 | 演示 mock 的失败注入 |

**新增环境变量必须同步 README**（这是仓库的既有纪律）。

## 提交规范

中文 Conventional Commits：`feat(ui): ...` / `fix(store): ...` / `docs: ...` / `refactor: ...`。一提交一逻辑单元；纯文档为 `docs`；行为修复为 `fix`。不要提交 `data/` 下的任何内容。

## 验证流程（改动后的最小闭环）

1. `npm test`（全绿才算过）；
2. 涉及对话链路时：`npm run demo` + `curl -N -X POST localhost:3737/api/chat/stream -d '{"message":"总结 https://demo.feishu.cn/docx/doccnABC123xyz"}'` 看 NDJSON 序列是否为 `start → tool → delta×n → done`；
3. 涉及前端时：浏览器实测（徽标、会话面板、流式打字机→done 渲染替换），确认 console 无报错；
4. 涉及会话存储时：检查落盘文件为紧凑 JSON、无 html/docs 字段。
