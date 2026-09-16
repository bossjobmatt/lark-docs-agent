# Lark 文档助手（本地演示）

本地启动一个 Web 服务：用户在输入框中粘贴 **飞书/Lark 文档链接 + 问题**，AI Agent 调用**本地 Lark CLI** 读取文档后回答，支持**流式输出**、**多轮对话**与 **Markdown 渲染**。

> 本项目是 lark CLI 的**纯调用方**：优先使用 `LARK_CLI` 环境变量指定的 CLI，否则探测 PATH 中已认证的 `lark`（`lark auth status` 返回成功即视为可用）；
> 两者都未检测到时不回落任何内置实现——文档相关调用会返回友好提示，引导用户自行安装并认证。本项目不负责 lark CLI 的安装与凭据配置。
> 仓库内置**模拟版 CLI**（`fixtures/lark-demo/`，配合三篇演示文档）仅供演示与测试，需显式启用：`npm run demo`。

## 职责边界

本项目只做三件事（调用方职责）：

1. **解析**：启动时确定用哪个 CLI——`LARK_CLI` 环境变量显式指定，否则探测 PATH 中通过 `lark auth status` 认证检查的 `lark`；
2. **调用**：按约定（JSON 信封 `{ code, msg, data }` + `auth status` / `doc list` / `doc get <url|token>` / `doc search <keyword>` 子命令）spawn 子进程执行，超时与异常兜底；
3. **呈现**：把调用结果以工具徽标、流式回答呈现；检测不到 CLI 时只透出引导提示（`health.lark.available=false`、徽标与欢迎页说明），聊天与流式输出不受影响。

明确不做：

- ❌ lark CLI 的安装、认证、凭据管理——没有 App ID / Secret 的任何配置入口
- ❌ lark CLI 的实现或内置默认——模拟 CLI 仅作为测试资产放在 `fixtures/lark-demo/`，`npm run demo` 才启用
- ❌ 任何「配置 lark CLI 服务」的界面或代码路径

也就是说：**lark CLI 从哪来（官方 / 自建 / 第三方）、怎么认证，完全是使用者自己的事**。只要它符合信封约定并放对位置（`LARK_CLI` 或 PATH），本项目零改动接入——该行为已由 `test/no-cli.test.js` 与 HTTP e2e 用例双向锁定。

支持两种 **Agent 模式**（界面「⚙️ 配置 LLM」中切换，保存即生效）：

| 模式 | 工作方式 | LLM 来源 |
| --- | --- | --- |
| **pi Agent**（默认） | lark CLI 使用规则写入 system prompt，由 [pi](https://pi.dev) SDK（`@earendil-works/pi-coding-agent`，**项目内依赖**）驱动的模型**自主调用**专用工具 `lark_doc_get`（内部执行本地 lark CLI）读取文档后回答；不暴露 bash 等任意命令 | 与内置模式**同一套界面凭据**：保存配置时自动写入自有目录 `data/pi-agent/`（models.json/settings.json） |
| **内置编排** | 服务端提取文档链接 → 预取文档 → 组装上下文 → LLM/模拟规则回答 | 界面配置的 OpenAI 兼容 API（chat / responses） |

**pi Agent 模式不依赖本地安装的 pi CLI**：SDK 来自项目 `node_modules`，凭据/模型目录由应用自己生成（`data/pi-agent/`，可用 `PI_AGENT_DIR` 覆盖）。已在「假 HOME + 无 `~/.pi` + 离线」环境下实测跑通。仅当界面未配置 Key 且本机装有已配置的 pi 时，才回退借用 `~/.pi/agent`（向后兼容）。

pi Agent 模式要点：

- 每个 UI 会话对应一个常驻 `AgentSession`（多轮记忆，追问无需重复发链接）；「清空会话」会同步销毁
- 工具调用过程通过 SDK 事件回传，前端展示 `$ lark_doc_get …` 徽标
- 界面凭据变化时自动刷新自有配置并废弃旧会话池；保存配置即时生效
- pi SDK 未安装、凭据缺失或处理超时（默认 120s，`PI_PROMPT_TIMEOUT_MS` 可调）时，**自动降级**为内置编排模式并在回复中提示
- 注意：`data/pi-agent/models.json` 与 `data/llm-config.json` 含明文 API Key，两者均已被 gitignore

## 结论（可行性评估）

**需求可行，且架构不复杂。** 已用模拟 CLI 验证全链路。对接外部已认证 lark CLI 的约定：stdout 输出 JSON 信封 `{ code, msg, data }`（`code === 0` 成功，进程退出码对应），子命令为 `auth status` / `doc list` / `doc get <url|token>` / `doc search <keyword>`。若需自行实现真实 CLI，主要工作量与风险点如下：

| 环节 | 现状（模拟） | 换真实 Lark CLI 的要点 |
| --- | --- | --- |
| 文档读取 | `fixtures/lark-demo/lark doc get` 读本地演示文档 | 官方没有现成的 `lark` 文档 CLI，通常需自建：封装飞书开放平台 OpenAPI（`docx/v1/documents/{id}/raw_content` 或 blocks 接口），用 App ID/Secret 换 tenant/user access token |
| 文档格式 | mock 文档即 Markdown | **最大坑点**：飞书 docx 是块（block）结构，API 返回 blocks，需要自己写 block → Markdown 转换器（表格/画板/附件等块较繁琐）；`raw_content` 接口只给纯文本 |
| 权限 | 无鉴权 | 应用需开通 `docx:document:readonly` 等权限并发布；用户/租户必须对文档有阅读权限，否则报 230002/99991672，需在回复中友好提示 |
| 限流与稳定 | 模拟延迟 150-400ms | OpenAPI 有频控（按应用/按用户），需做重试与退避；CLI 超时兜底本 demo 已实现 |
| AI 回复 | 本地规则匹配（模拟模式） | 配置任一 OpenAI 兼容 `LLM_API_KEY` 即切换为真 LLM 回答；文档全文作为上下文，长文档需做分段/摘要 |
| 部署 | 仅绑定 127.0.0.1 | 本地单机使用安全；若要暴露给团队，需加登录鉴权与 HTTPS |

另一条可选路线：直接使用官方开源的 [`@larksuiteoapi/lark-mcp`](https://www.npmjs.com/package/@larksuiteoapi/lark-mcp)（把飞书 OpenAPI 封装成 MCP 工具供 Agent 调用），可省去自建 CLI 与 block 转换的部分工作。

## 快速开始

```bash
npm install
npm start          # 启动后访问 http://127.0.0.1:3737
npm run dev        # 开发模式（node --watch，改动自动重启）
npm test           # 运行测试套件（node --test，含 HTTP e2e 与 mock 网关 fixture）
```

- 首次启动（未检测到 lark CLI、未配置 LLM Key）：徽标与欢迎页会提示「未检测到 lark CLI」，示例文档列表为空；带文档链接提问时，回答中会说明需要本地安装并认证 lark CLI。聊天与流式输出不受影响。
- 演示模式（无真实 CLI 体验全链路）：`npm run demo`，使用 `fixtures/lark-demo/` 的模拟 CLI 与演示文档。
- 默认绑定 `127.0.0.1:3737`，可用 `HOST` / `PORT` 环境变量覆盖（如 `PORT=8080 npm start`）。

### 点击配置 LLM（界面内，保存即生效）

点击右上角 **「⚙️ 配置 LLM」**，在弹窗中填写：

| 字段 | 说明 |
| --- | --- |
| Agent 模式 | `pi`（pi Agent，默认）或 `builtin`（内置编排）；两种模式共用下方同一套凭据 |
| 接口类型 | `chat`（Chat Completions，`/chat/completions`）或 `responses`（Responses，`/responses`） |
| Base URL | 任意 OpenAI 兼容网关，默认 `https://api.openai.com/v1` |
| API Key | 保存后打码显示（`sk-****xxxx`），留空表示保持不变 |
| 模型 | 支持两种方式：点击 **「↻ 拉取列表」** 从网关拉取（`GET /models`）后用 **select 下拉选择**；或点击 **「✏️ 手动输入」** 自由填写任意模型名（两种模式值互相同步） |

以上凭据为两种 Agent 模式共用：内置模式直接读取；保存配置时同时自动写入 pi 模式的自有目录 `data/pi-agent/`（models.json/settings.json）。

支持 **「测试连接」**（用表单当前值发一条真实请求）与 **「恢复默认」**（清除配置回到模拟模式）。配置持久化在 `data/llm-config.json`（已 gitignore），无需重启服务、无需环境变量；环境变量仅作为未配置时的默认值：`LLM_API_KEY`（别名 `OPENAI_API_KEY`）、`LLM_BASE_URL`（别名 `OPENAI_BASE_URL`）、`LLM_MODEL`、`LLM_API_TYPE`、`AGENT_MODE`（`builtin` / `pi`，默认 `pi`）。

## 演示用模拟 CLI（内置，需显式启用）

```bash
npm run demo                    # 服务以内置模拟 CLI 运行（LARK_CLI=./fixtures/lark-demo/lark）
npm run lark -- auth status                     # 认证状态
npm run lark -- doc list                        # 列出可访问文档
npm run lark -- doc get https://demo.feishu.cn/docx/doccnABC123xyz
npm run lark -- doc get doccnFAQ789rst          # 裸 token 也可以
npm run lark -- doc search 上线                 # 关键词搜索
```

输出为统一 JSON 信封 `{ code, msg, data }`（`code === 0` 成功，与飞书 OpenAPI 风格一致，非 0 时进程退出码为 1）。演示文档共 3 篇，位于 `fixtures/lark-demo/mock-data/docs/`。支持失败注入：`LARK_FAIL_RATE=0.5`（doc get 50% 概率失败）用于演示降级链路。

## 架构

```
浏览器 (public/)                     本地服务 (src/)                  lark CLI（外部）
┌──────────────────┐   POST /api/chat  ┌────────────────────┐   spawn   ┌─────────────┐
│ 输入框 + 多轮消息  │ ────────────────▶ │ server.js 路由      │ ────────▶ │ lark CLI*    │
│ Markdown 渲染     │ ◀──────────────── │ agent.js 编排：     │ ◀──────── │ doc get/list │
│ 工具调用徽标      │   HTML + 历史      │  ① 提取文档链接/token│  JSON信封  │ search/auth  │
└──────────────────┘                    │  ② 调 lark CLI 读文档│           └─────────────┘
                                        │  ③ LLM / 模拟规则回答 │
                                        │  ④ 会话存储+文档缓存  │
                                        └────────────────────┘
```

- **agent.js**：从消息中提取飞书/Lark 链接（`feishu.cn` / `larksuite.com` / `larkoffice.com`，或 `doccn` 开头裸 token，单条最多 3 篇）→ 调 CLI → 组装上下文 → LLM 回答或降级模拟回答。
- **protocol.js**：流式事件（`start` / `tool` / `delta` / `done` / `error`）与回复对象的唯一契约定义——agent/pi 生产、server 转发、前端消费共享同一份词汇表。
- **会话缓存**：同一会话内同一文档只调一次 CLI（重复发送链接会显示 ⚡ 缓存命中徽标）；缓存仅存内存（每会话上限 20 篇），服务重启后同文档会重调 CLI。
- **多轮持久化**：会话与消息落盘 `data/sessions.json`，服务重启后刷新页面不丢历史。
- **存储瘦身与淘汰**：落盘为紧凑 JSON，只存 Markdown 原文（html 渲染结果不落盘，加载时按原文现算；docs 文档缓存不落盘）；会话自动淘汰——默认 7 天不活跃（`SESSION_TTL_DAYS`，显式 0 生效）或总数超过 100 个（`SESSION_MAX_COUNT`）即删，每会话仅保留最近 50 条消息（`SESSION_MAX_MESSAGES`）。
- **上下文预算与选段**：LLM 输入按字符预算控制（默认 24000，`CONTEXT_BUDGET_CHARS` 可调）；超过 8000 字（`DOC_FULL_TEXT_MAX` 可调）的文档不再整篇进上下文，改为按问题相关度节选 top-k 章节 + 全文大纲；超限类失败先裁剪最早缓存文档自愈重试一次，仍失败才降级模拟。
- **会话管理**：页头「🗂 会话」面板列出全部历史会话（按最近活跃排序），支持切换、新建、删除；匿名新对话自动创建新会话。
- **Markdown 渲染**：服务端用 `marked` 转 HTML 并做轻量消毒（去 `<script>`/`<iframe>`/内联事件），前端零依赖。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与模式探测（sim / llm，含当前模型与接口类型） |
| GET | `/api/examples` | 示例文档列表（真实经 CLI `doc list` 取得） |
| GET | `/api/history?sessionId=` | 取会话历史 |
| POST | `/api/chat` | `{ sessionId?, message }` → 瘦身响应：`{ sessionId, mode, message }`（前端本地维护列表，不再回传全量 history） |
| POST | `/api/chat/stream` | 流式对话：NDJSON 事件行（`start` / `tool` / `delta` / `done` / `error`），`done` 携带完整回复（含渲染 HTML） |
| GET | `/api/sessions` | 会话列表（按最近活跃倒序，含标题/条数，供会话管理面板） |
| POST | `/api/session/clear` | 清空会话 |
| POST | `/api/session/delete` | 删除会话（同时销毁 pi Agent 会话记忆） |
| GET | `/api/llm/config` | 读 LLM 配置（API Key 打码） |
| POST | `/api/llm/config` | 保存 LLM 配置，保存即生效 |
| POST | `/api/llm/config/reset` | 清除配置，回落环境变量/默认值 |
| POST | `/api/llm/test` | 用传入（或已存）配置发真实请求，测试连通性 |
| POST | `/api/llm/models` | 拉取 OpenAI 兼容模型列表（`GET {baseUrl}/models`） |

替换为真实 Lark CLI（可选）：`LARK_CLI=/path/to/real-lark npm start`，或确保 PATH 中的 `lark` 已认证（服务启动时自动探测）。模拟 CLI 支持失败注入：`LARK_FAIL_RATE=0.5`（doc get 50% 概率失败）用于演示降级链路。

## 已验证的端到端场景

1. 粘贴文档链接提问 → 工具徽标展示 `$ lark doc get …`，回答定位到对应章节并摘录；
2. 同会话追问（如「里程碑计划是什么？」）→ 命中缓存直接回答，Markdown 表格正常渲染；
3. 无效文档链接 → 错误徽标提示「document not found or no permission」，对话不中断；
4. 刷新页面 → 历史消息（含渲染后的 Markdown）完整恢复；
5. 界面点击配置 LLM（chat 与 responses 两种类型，经本地 mock OpenAI 服务验证）→ 测试连接、保存生效、徽标联动、Agent 将文档上下文与多轮历史一并交给 LLM、「恢复默认」回模拟模式；
6. 模型字段：点「拉取列表」经 `GET /models` 取回后以下拉列表选择，或切换「手动输入」自由填写，双模式值同步；
7. **pi Agent 模式**：system prompt 规则驱动，模型自主调用 `lark_doc_get` 读取文档并回答；同会话追问无需重复发链接（会话记忆）；SDK 缺失时自动降级为内置编排并在回复中提示；
8. **无 pi 安装环境**：以假 HOME（无 `~/.pi`）+ 离线模式启动服务，仅凭界面配置的凭据跑通 pi 模式全流程（首问调工具、追问靠会话记忆、UI 徽标正常），证明 pi 模式零依赖本地安装的 pi；
9. **回答卡片操作**：每条回答下方提供「⧉ 复制」（复制 Markdown 原文到剪贴板，带 ✓ 反馈）与「Raw / 渲染」切换（Markdown 源码视图与渲染视图互切）；
10. **流式输出**：`/api/chat/stream` 逐段推送——内置 LLM 模式解析 `chat` 与 `responses` 两种 SSE 增量，pi 模式转发 SDK `text_delta` 事件，模拟模式假流式；前端打字机展示原文、工具徽标先行展示，`done` 后整体替换为渲染卡片；
11. **会话管理**：「🗂 会话」面板切换/新建/删除历史会话，切换即恢复该会话完整历史（含渲染 Markdown）；
12. **无 lark CLI 环境**：未检测到已认证 CLI 时，health 报告 `lark.available=false`，徽标提示「未检测到 lark CLI」，带文档链接提问返回安装认证引导（不执行任何命令）；接入真实 CLI（`LARK_CLI` 或 PATH）后自动生效，无需改动本项目。

## 依赖说明

- `marked`：服务端 Markdown → HTML 渲染
- `@earendil-works/pi-coding-agent` + `typebox`：pi Agent 模式的 SDK 与工具参数 schema（项目内依赖，随 `npm install` 安装，无需全局安装 pi CLI；未安装时内置编排不受影响）

## 局限（演示定位）

- 模拟模式的回答是关键词规则匹配，仅证明链路，不等于 AI 效果；接入 LLM Key 后即为真实问答。
- 单机内存/文件存储，无用户体系；上下文已做字符预算与长文档选段，跨会话语义检索（RAG）为后续增强项。
