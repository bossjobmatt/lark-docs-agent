# Lark 文档助手（本地演示）

本地启动一个 Web 服务：用户在输入框中粘贴 **飞书/Lark 文档链接 + 问题**，AI Agent 调用**本地 Lark CLI** 读取文档后回答，支持**流式输出**、**多轮对话**与 **Markdown 渲染**。

> 本仓库内置一个**模拟版 lark CLI**（`bin/lark`），无需真实安装与鉴权即可跑通全链路；
> 通过 `LARK_CLI` 环境变量可无缝替换为真实 CLI。

支持两种 **Agent 模式**（界面「⚙️ 配置 LLM」中切换，保存即生效）：

| 模式 | 工作方式 | LLM 来源 |
| --- | --- | --- |
| **内置编排**（默认） | 服务端提取文档链接 → 预取文档 → 组装上下文 → LLM/模拟规则回答 | 界面配置的 OpenAI 兼容 API（chat / responses） |
| **pi Agent** | lark CLI 使用规则写入 system prompt，由 [pi](https://pi.dev) SDK（`@earendil-works/pi-coding-agent`，**项目内依赖**）驱动的模型**自主调用**专用工具 `lark_doc_get`（内部执行本地 lark CLI）读取文档后回答；不暴露 bash 等任意命令 | 与内置模式**同一套界面凭据**：保存配置时自动写入自有目录 `data/pi-agent/`（models.json/settings.json） |

**pi Agent 模式不依赖本地安装的 pi CLI**：SDK 来自项目 `node_modules`，凭据/模型目录由应用自己生成（`data/pi-agent/`，可用 `PI_AGENT_DIR` 覆盖）。已在「假 HOME + 无 `~/.pi` + 离线」环境下实测跑通。仅当界面未配置 Key 且本机装有已配置的 pi 时，才回退借用 `~/.pi/agent`（向后兼容）。

pi Agent 模式要点：

- 每个 UI 会话对应一个常驻 `AgentSession`（多轮记忆，追问无需重复发链接）；「清空会话」会同步销毁
- 工具调用过程通过 SDK 事件回传，前端展示 `$ lark_doc_get …` 徽标
- 界面凭据变化时自动刷新自有配置并废弃旧会话池；保存配置即时生效
- pi SDK 未安装、凭据缺失或处理超时（默认 120s，`PI_PROMPT_TIMEOUT_MS` 可调）时，**自动降级**为内置编排模式并在回复中提示
- 注意：`data/pi-agent/models.json` 与 `data/llm-config.json` 含明文 API Key，两者均已被 gitignore

## 结论（可行性评估）

**需求可行，且架构不复杂。** 已用模拟 CLI 验证全链路。将模拟 CLI 换成真实实现时，主要工作量与风险点如下：

| 环节 | 现状（模拟） | 换真实 Lark CLI 的要点 |
| --- | --- | --- |
| 文档读取 | `bin/lark doc get` 读本地 mock 文件 | 官方没有现成的 `lark` 文档 CLI，通常需自建：封装飞书开放平台 OpenAPI（`docx/v1/documents/{id}/raw_content` 或 blocks 接口），用 App ID/Secret 换 tenant/user access token |
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
```

- 默认运行在**模拟模式**（无 LLM Key，回复由本地规则生成，演示链路用）。
- 默认绑定 `127.0.0.1:3737`，可用 `HOST` / `PORT` 环境变量覆盖（如 `PORT=8080 npm start`）。

### 点击配置 LLM（界面内，保存即生效）

点击右上角 **「⚙️ 配置 LLM」**，在弹窗中填写：

| 字段 | 说明 |
| --- | --- |
| Agent 模式 | `builtin`（内置编排）或 `pi`（pi Agent，模型自主调用 lark CLI） |
| 接口类型 | `chat`（Chat Completions，`/chat/completions`）或 `responses`（Responses，`/responses`）——仅内置模式使用 |
| Base URL | 任意 OpenAI 兼容网关，默认 `https://api.openai.com/v1`——仅内置模式使用 |
| API Key | 保存后打码显示（`sk-****xxxx`），留空表示保持不变——仅内置模式使用 |
| 模型 | 支持两种方式：点击 **「↻ 拉取列表」** 从网关拉取（`GET /models`）后用 **select 下拉选择**；或点击 **「✏️ 手动输入」** 自由填写任意模型名（两种模式值互相同步）——仅内置模式使用 |

支持 **「测试连接」**（用表单当前值发一条真实请求）与 **「恢复默认」**（清除配置回到模拟模式）。配置持久化在 `data/llm-config.json`（已 gitignore），无需重启服务、无需环境变量；环境变量仅作为未配置时的默认值：`LLM_API_KEY`（别名 `OPENAI_API_KEY`）、`LLM_BASE_URL`（别名 `OPENAI_BASE_URL`）、`LLM_MODEL`、`LLM_API_TYPE`、`AGENT_MODE`（`builtin` / `pi`，默认 `builtin`）。

## 模拟 CLI 用法

```bash
npm run lark -- auth status                     # 认证状态
npm run lark -- doc list                        # 列出可访问文档
npm run lark -- doc get https://demo.feishu.cn/docx/doccnABC123xyz
npm run lark -- doc get doccnFAQ789rst          # 裸 token 也可以
npm run lark -- doc search 上线                 # 关键词搜索
```

输出为统一 JSON 信封 `{ code, msg, data }`（`code === 0` 成功，与飞书 OpenAPI 风格一致，非 0 时进程退出码为 1）。模拟文档共 3 篇，位于 `mock-data/docs/`。

## 架构

```
浏览器 (public/)                     本地服务 (src/)                    模拟 CLI
┌──────────────────┐   POST /api/chat  ┌────────────────────┐   spawn   ┌─────────────┐
│ 输入框 + 多轮消息  │ ────────────────▶ │ server.js 路由      │ ────────▶ │ bin/lark     │
│ Markdown 渲染     │ ◀──────────────── │ agent.js 编排：     │ ◀──────── │ doc get/list │
│ 工具调用徽标      │   HTML + 历史      │  ① 提取文档链接/token│  JSON信封  │ search/auth  │
└──────────────────┘                    │  ② 调 lark CLI 读文档│           └─────────────┘
                                        │  ③ LLM / 模拟规则回答 │
                                        │  ④ 会话存储+文档缓存  │
                                        └────────────────────┘
```

- **agent.js**：从消息中提取飞书/Lark 链接（`feishu.cn` / `larksuite.com` / `larkoffice.com`，或 `doccn` 开头裸 token，单条最多 3 篇）→ 调 CLI → 组装上下文 → LLM 回答或降级模拟回答。
- **会话缓存**：同一会话内同一文档只调一次 CLI（重复发送链接会显示 ⚡ 缓存命中徽标）；缓存仅存内存（每会话上限 20 篇），服务重启后同文档会重调 CLI。
- **多轮持久化**：会话与消息落盘 `data/sessions.json`，服务重启后刷新页面不丢历史。
- **存储瘦身与淘汰**：落盘为紧凑 JSON，只存 Markdown 原文（html 渲染结果不落盘，加载时按原文现算；docs 文档缓存不落盘）；会话自动淘汰——默认 7 天不活跃（`SESSION_TTL_DAYS`）或总数超过 100 个（`SESSION_MAX_COUNT`）即删，每会话仅保留最近 50 条消息（`SESSION_MAX_MESSAGES`）。
- **Markdown 渲染**：服务端用 `marked` 转 HTML 并做轻量消毒（去 `<script>`/`<iframe>`/内联事件），前端零依赖。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与模式探测（sim / llm，含当前模型与接口类型） |
| GET | `/api/examples` | 示例文档列表（真实经 CLI `doc list` 取得） |
| GET | `/api/history?sessionId=` | 取会话历史 |
| POST | `/api/chat` | `{ sessionId?, message }` → 回复 + 完整历史 |
| POST | `/api/chat/stream` | 流式对话：NDJSON 事件行（`start` / `tool` / `delta` / `done` / `error`），`done` 携带完整回复（含渲染 HTML） |
| POST | `/api/session/clear` | 清空会话 |
| GET | `/api/llm/config` | 读 LLM 配置（API Key 打码） |
| POST | `/api/llm/config` | 保存 LLM 配置，保存即生效 |
| POST | `/api/llm/config/reset` | 清除配置，回落环境变量/默认值 |
| POST | `/api/llm/test` | 用传入（或已存）配置发真实请求，测试连通性 |
| POST | `/api/llm/models` | 拉取 OpenAI 兼容模型列表（`GET {baseUrl}/models`） |

替换为真实 Lark CLI（可选）：`LARK_CLI=/path/to/real-lark npm start`。

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
10. **流式输出**：`/api/chat/stream` 逐段推送——内置 LLM 模式解析 `chat` 与 `responses` 两种 SSE 增量，pi 模式转发 SDK `text_delta` 事件，模拟模式假流式；前端打字机展示原文、工具徽标先行展示，`done` 后整体替换为渲染卡片。

## 依赖说明

- `marked`：服务端 Markdown → HTML 渲染
- `@earendil-works/pi-coding-agent` + `typebox`：pi Agent 模式的 SDK 与工具参数 schema（项目内依赖，随 `npm install` 安装，无需全局安装 pi CLI；未安装时内置编排不受影响）

## 局限（演示定位）

- 模拟模式的回答是关键词规则匹配，仅证明链路，不等于 AI 效果；接入 LLM Key 后即为真实问答。
- 单机内存/文件存储，无用户体系；长文档分片（超大文档仍整篇进入上下文，超限时降级模拟）为后续增强项；流式输出已支持（NDJSON over fetch）。
