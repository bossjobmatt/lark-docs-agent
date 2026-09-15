/**
 * pi Agent 模式：通过 @earendil-works/pi-coding-agent SDK 编程式接入。
 *
 * 职责划分与「内置编排」不同：这里不在服务端预取文档，而是把规则写进 system prompt，
 * 由 pi 驱动的模型自主决定何时调用工具；工具内部执行本地 Lark CLI（bin/lark）。
 * - 专用工具 lark_doc_get（defineTool 注册），不暴露 bash 等任意命令执行面
 * - 每个 UI 会话对应一个常驻 AgentSession（多轮记忆），上限 LRU 淘汰
 * - tool_execution_* 事件映射为前端工具徽标（toolCalls）
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Type } = require("typebox");
const llm = require("./llm");
const { runLarkCli } = require("./lark");
const { renderMarkdown } = require("./markdown");

const TOOL_NAME = "lark_doc_get";
const PROMPT_TIMEOUT_MS = Number(process.env.PI_PROMPT_TIMEOUT_MS) || 120000;
const MAX_SESSIONS = 50;
const PROJECT_ROOT = path.join(__dirname, "..");
// pi 模式自有配置目录（models.json/settings.json 由应用生成，不依赖本机安装的 pi）
const OWN_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(PROJECT_ROOT, "data", "pi-agent");

const SYSTEM_PROMPT = [
  "你是部署在本地服务中的 Lark 文档问答助手。",
  "当用户消息包含飞书/Lark 文档链接（国内版 feishu.cn、国际版 larksuite.com 或 larkoffice.com，路径含 /docx/、/docs/、/wiki/）或 doccn 开头的文档 token 时，必须先调用 lark_doc_get 工具获取文档内容，再基于内容回答用户的问题。",
  "如消息中出现多份文档，逐一调用工具。",
  "回答要求：优先依据文档内容，引用时注明章节名；文档未覆盖的内容明确说明，不要编造；工具调用失败时向用户说明原因。",
  "使用 Markdown 输出，始终用中文。",
].join("\n");

// 动态加载 ESM SDK（项目为 CJS）；失败不永久缓存，退避后允许重试（如依赖恢复后免重启）
let piPromise = null;
let lastFailAt = 0;
function loadPi() {
  if (piPromise) return piPromise;
  if (Date.now() - lastFailAt < 3000) return Promise.resolve(null);
  piPromise = import("@earendil-works/pi-coding-agent")
    .catch((e) => {
      lastFailAt = Date.now();
      piPromise = null; // 允许下次重试
      console.error("[pi-agent] SDK 加载失败，pi 模式暂不可用:", e.message);
      return null;
    });
  return piPromise;
}

/** pi 是否可用（已安装且能导入） */
async function isAvailable() {
  return (await loadPi()) !== null;
}

function makeLarkTool() {
  return defineTool({
    name: TOOL_NAME,
    label: "Lark 文档读取",
    description:
      "读取飞书/Lark 文档全文（Markdown）。当用户消息包含 feishu.cn（国内版）、larksuite.com 或 larkoffice.com（国际版）的文档链接，或 doccn 开头的文档 token 时，用本工具获取内容。",
    parameters: Type.Object({
      doc: Type.String({ description: "飞书/Lark 文档链接或文档 token，例如 https://demo.feishu.cn/docx/doccnABC123xyz" }),
    }),
    execute: async (_toolCallId, params) => {
      const res = await runLarkCli(["doc", "get", params.doc]);
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Lark CLI 调用失败：${res.msg}` }],
          details: { summary: `调用失败：${res.msg}` },
        };
      }
      const d = res.data;
      return {
        content: [
          { type: "text", text: `【文档：《${d.title}》，更新于 ${d.update_time}，链接 ${d.url}】\n\n${d.content}` },
        ],
        details: { summary: `已读取《${d.title}》（${d.word_count} 字）` },
      };
    },
  });
}

// defineTool 来自 pi 的 ESM 导出，这里在模块加载后填充
let defineTool = null;

function extractText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
  return "";
}

const sessions = new Map(); // sessionId -> { session, busy: Promise }

// ---------- 自有 agentDir：凭据来自界面 LLM 配置，使 pi 模式不依赖本机安装的 pi ----------

let configFingerprint = "";

function resolveAgentDir() {
  // 1) 显式指定（PI_AGENT_DIR）
  if (process.env.PI_AGENT_DIR) return { dir: process.env.PI_AGENT_DIR, source: "env(PI_AGENT_DIR)" };

  // 2) 界面已配置 LLM 凭据 → 生成/刷新自有目录（主路径，无 pi 安装也可运行）
  if (llm.isConfigured()) {
    try {
      writeOwnConfig(OWN_AGENT_DIR);
      return { dir: OWN_AGENT_DIR, source: "app(界面配置)" };
    } catch (e) {
      console.error("[pi-agent] 自有配置生成失败:", e.message);
    }
  }

  // 3) 兜底：本机已配置 pi（~/.pi/agent 有 provider 定义）时借用
  const piDir = path.join(os.homedir(), ".pi", "agent");
  if (fs.existsSync(path.join(piDir, "models.json"))) return { dir: piDir, source: "pi(~/.pi/agent)" };

  return null;
}

/** 把界面 LLM 配置写成 pi 的 models.json/settings.json；配置变化时废弃旧会话池 */
function writeOwnConfig(dir) {
  const cfg = llm.publicConfig();
  const apiKey = llm.getApiKey();
  const fingerprint = [cfg.baseUrl, cfg.model, cfg.apiType, apiKey].join("|");
  if (fingerprint === configFingerprint) return;

  for (const id of [...sessions.keys()]) dispose(id); // 模型/网关变了，旧会话作废

  const providerId = "lark-docs";
  const provider = {
    name: providerId,
    api: cfg.apiType === "responses" ? "openai-responses" : "openai-completions",
    baseUrl: cfg.baseUrl,
    apiKey,
    authHeader: true,
    models: [{ id: cfg.model, name: cfg.model }],
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { [providerId]: provider } }, null, 2));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: providerId, defaultModel: cfg.model }));
  configFingerprint = fingerprint;
  console.log(`[pi-agent] 已生成自有 pi 配置: ${dir}（${provider.api} · ${cfg.model}）`);
}

function evictIfNeeded() {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    dispose(oldest);
  }
}

function dispose(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry) {
    try {
      entry.session.dispose();
    } catch {
      /* 忽略 */
    }
    sessions.delete(sessionId);
  }
}

async function getOrCreateSession(pi, sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  if (!defineTool) defineTool = pi.defineTool;

  const resolved = resolveAgentDir();
  if (!resolved) {
    throw new Error("pi 模式缺少 LLM 凭据：请在「配置 LLM」中填写 API Key（或本机已配置 pi 的 ~/.pi/agent）");
  }
  console.log(`[pi-agent] 新建会话，agentDir=${resolved.dir}（来源: ${resolved.source}）`);

  const loader = new pi.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: resolved.dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true, // 不发现 AGENTS.md，避免污染文档问答角色
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await pi.createAgentSession({
    cwd: process.cwd(),
    agentDir: resolved.dir, // 凭据/模型运行时同样使用自有目录
    sessionManager: pi.SessionManager.inMemory(),
    tools: [TOOL_NAME], // 只允许专用工具，不暴露 read/bash/edit/write
    customTools: [makeLarkTool()],
    resourceLoader: loader,
  });

  evictIfNeeded();
  const entry = { session, busy: Promise.resolve() };
  sessions.set(sessionId, entry);
  return entry;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（>${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 运行一轮 pi Agent 对话。
 * 提供 onEvent 时逐段回调 { type: "tool", toolCalls }（快照）与 { type: "delta", text }（增量）。
 * 返回 { content, html, toolCalls, mode: "pi" }；失败抛错，由上层降级。
 */
async function run(message, sessionId, { onEvent } = {}) {
  const pi = await loadPi();
  if (!pi) throw new Error("pi SDK 未安装（npm i @earendil-works/pi-coding-agent）");

  const entry = await getOrCreateSession(pi, sessionId);
  const toolCalls = [];

  // 同一会话串行执行，避免 prompt 并发冲突
  const task = entry.busy.then(async () => {
    const unsubscribe = bindToolEvents(entry, toolCalls, onEvent);
    try {
      await withTimeout(entry.session.prompt(message), PROMPT_TIMEOUT_MS, "pi 处理超时");
    } catch (e) {
      try {
        await entry.session.abort();
      } catch {
        /* 会话可能已结束 */
      }
      throw e;
    } finally {
      unsubscribe();
    }
    return extractReply(entry.session, toolCalls);
  });
  entry.busy = task.catch(() => {});
  return task;
}

/** 订阅工具执行与文本增量事件，映射为前端徽标/流式结构；返回退订函数 */
function bindToolEvents(entry, toolCalls, onEvent) {
  const pending = new Map(); // toolCallId -> index in toolCalls
  const emitTools = () => onEvent && onEvent({ type: "tool", toolCalls: [...toolCalls] });
  const unsubscribe = entry.session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      pending.set(event.toolCallId, toolCalls.length);
      toolCalls.push({
        tool: event.toolName,
        args: String(event.args && (event.args.doc || event.args.input || JSON.stringify(event.args)) || "").slice(0, 80),
        status: "ok",
        summary: "执行中…",
      });
      emitTools();
    } else if (event.type === "tool_execution_end") {
      const idx = pending.has(event.toolCallId) ? pending.get(event.toolCallId) : toolCalls.length - 1;
      const item = toolCalls[idx];
      if (item) {
        item.status = event.isError ? "error" : "ok";
        item.summary =
          (event.result && event.result.details && event.result.details.summary) ||
          (event.isError ? "调用失败" : "完成");
      }
      emitTools();
    } else if (event.type === "message_update") {
      // 转发正文增量；跳过 thinking 增量与工具参数增量
      const ame = event.assistantMessageEvent;
      if (onEvent && ame && ame.type === "text_delta" && ame.delta) {
        onEvent({ type: "delta", text: ame.delta });
      }
    }
  });
  return unsubscribe;
}

/** 从会话消息中取最后一条助手回复的文本 */
function extractReply(session, toolCalls) {
  const assistants = session.messages.filter((m) => m && m.role === "assistant");
  const last = assistants[assistants.length - 1];
  const content = extractText(last);
  if (!content.trim()) throw new Error("pi 未返回文本内容");
  return { content, html: renderMarkdown(content), toolCalls, mode: "pi" };
}

/** 界面配置变化后立即同步自有 agentDir（供 /api/llm/config 保存时调用） */
function syncConfig() {
  if (!llm.isConfigured()) return;
  try {
    writeOwnConfig(OWN_AGENT_DIR);
  } catch (e) {
    console.error("[pi-agent] 自有配置同步失败:", e.message);
  }
}

module.exports = { run, dispose, isAvailable, syncConfig };
