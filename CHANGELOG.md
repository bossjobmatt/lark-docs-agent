# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- 页面加载后立即发送消息时，晚到的会话历史恢复（`refresh`）会整建消息流、抹掉正在流式渲染的气泡（回复在后台完成但不可见）；初始化现在在流式进行中跳过历史恢复。

### 新增

- `AGENTS.md`：AI 编码代理工作指引（架构地图、模块纪律、测试与提交规范），README 增加引用入口。

### 变更

- **流式渲染空白治理**：流式期间改为「稳定前缀 + 活跃尾行」增量渲染——marked 只解析完整行，半截块开头（`##`/`-`/``` 围栏）不再被渲染成空标题/空列表项/空代码块（实测消除全部空白帧，在屏 119–351ms → 0）；未完行以纯文本尾随保持打字机观感，围栏开启行在无代码内容时退回尾行。阶段提示（typing）改为隐藏/复现：正文出现即让位，流中停顿超 2s 复用同一元素提示「等待模型响应…」。流式引擎拆分至新模块 `public/js/stream.js`（`chat.js` 回到 ≤300 行约束内）。
- **marked 升级 12.0.2 → 18.0.13**：v13–v18 的破坏性变更均不触及本项目使用的 `marked.parse()` + `gfm`/`breaks` API 面（22 项渲染语料对比仅 1 项良性差异）；vendored UMD 随 npm 依赖同步（v16 起为压缩版，45.8 KB ← 100.5 KB）。**Node 下限由 18 升至 20.19**（marked v16+ 仅提供 ESM 构建，服务端 `require("marked")` 依赖 require(esm)），`engines`、`AGENTS.md`、README 同步更新。
- **体验优化**：生成期间发送键变「⏹ 停止」（经 AbortController 中止，服务端同步中止上游请求）；流式期间用 vendored marked 增量渲染（节流 ~90ms + 轻量消毒），done 后仍替换为服务端权威渲染；自动滚动节流（用户上翻暂停跟随）；typing 指示随事件阶段更新且 2s 无进展提示「等待模型响应…」（计时覆盖等待响应头阶段）；失败气泡带「↻ 重试」；删除会话二次确认；等待期间输入框保持可编辑。
- **徽标拆分**：单一徽标拆为三个独立 chip——Agent/LLM 模式、lark CLI 状态（未检测到时显示）、pi SDK 降级（异常时显示），按需显示不再互相挤占。
- **前端模块化**：`app.js` 拆分为原生 ES modules（`state` / `ui` / `api` / `health` / `chat` / `sessions` / `llm-modal`），无打包器；新增硬性约束「单文件 ≤300 行、职责单一」（见 `AGENTS.md`）。
- 服务端静态服务从三文件白名单改为 `public/` 通用处理（保留路径穿越防护）。
- 演示 mock 网关支持 `MOCK_PIECE_DELAY_MS` 调速，便于流式中间态的确定性验证。

## [0.2.0] - 2026-09-16

### 新增

- **流式输出**：`POST /api/chat/stream`，NDJSON 事件行（`start` / `tool` / `delta` / `done` / `error`），事件契约集中在 `src/protocol.js`；客户端断开时中止上游 LLM 请求（内置与 pi 分支均覆盖）。
- **会话管理**：页头「🗂 会话」面板（列表 / 切换 / 新建 / 删除），`GET /api/sessions` + `POST /api/session/delete`；会话标题在首轮回复后由 LLM 自动生成（未配置 LLM 时回落首条消息截断）。
- **上下文预算与长文档选段**：LLM 输入按字符预算控制（`CONTEXT_BUDGET_CHARS`，默认 24000）；超 `DOC_FULL_TEXT_MAX`（8000 字）的文档按问题相关度节选 top-k 章节 + 全文大纲；超限类失败先裁剪最早缓存文档自愈重试一次。
- **会话存储治理**：紧凑 JSON、仅存 Markdown 原文（html 现算、docs 缓存仅内存）；按不活跃时间（默认 7 天）/ 总量（默认 100 个）自动淘汰；每会话保留最近 50 条消息。
- **原生测试体系**：`node --test`，store / llm-config / agent 纯函数 + HTTP e2e（spawn 演示 mock CLI 与 mock OpenAI 网关 fixture），共 22 用例。
- `AGENTS.md` 前身约定入 README：lark CLI 纯调用方职责边界、对接约定（JSON 信封 + 子命令）。

### 变更

- **重定位为 lark CLI 纯调用方**：CLI 三级解析（`LARK_CLI` 显式指定 → PATH 探测已认证 `lark` → 无）；未检测到时不回落任何内置实现，文档相关调用返回安装认证引导。内置模拟 CLI 降级为显式演示件（`npm run demo`），并移入测试域 `fixtures/lark-demo/`。
- **pi Agent 设为默认模式**（`AGENT_MODE=builtin` 显式切回）；配置字段（Base URL / 模型 / Key / 接口类型）两种模式共用，修正「仅内置模式使用」的过时标注。
- **模块深化**：store 收回变更所有权（移除 `persist` 导出，新增 `appendMessages` / `cacheDoc`，变更即触活+裁剪+落盘）；llm.js 拆分为 `llm-config.js`（配置）+ `llm.js`（客户端）。
- 演示 mock CLI 支持失败注入：`LARK_FAIL_RATE`（doc get 按概率失败，演示降级链路）。
- 示例文档区为空或加载失败时自动隐藏，避免悬空标签。

### 修复

- 客户端断开中止上游请求此前未覆盖 pi 分支（signal 在调用点被丢弃）。
- LLM 失败降级为模拟内容时未走假流式，流式气泡停留空白。
- `SESSION_TTL_DAYS=0` 等显式 0 值被 `|| 默认` 吞掉。

## [0.1.0] - 2026-09-15

### 新增

- 初始版本：本地 Web 服务（原生 http，零框架），粘贴飞书/Lark 文档链接 + 问题，Agent 调用（模拟）Lark CLI 读取文档后回答，支持多轮对话与 Markdown 渲染。
- 内置模拟 CLI（`auth status` / `doc list` / `doc get` / `doc search`，JSON 信封约定）与 3 篇演示文档。
- 两种 Agent 模式：内置编排（服务端预取文档）与 pi Agent（SDK 接入，模型自主调用工具）；pi 模式不依赖本地安装的 pi CLI，凭据由界面配置自持。
- 界面内配置 LLM（OpenAI 兼容，chat / responses 双接口类型），保存即生效；回答卡片支持复制与 Raw/渲染切换。
- 会话持久化（`data/sessions.json`）、同会话文档缓存、工具调用徽标。
