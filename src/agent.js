const { runLarkCli } = require("./lark");
const llm = require("./llm");
const llmConfig = require("./llm-config");
const piAgent = require("./pi-agent");
const store = require("./store");
const { toUserContent } = require("./images");
const { buildSimReply, splitSections, sectionScore, outlineOf } = require("./sim-reply");
const { makeReply, nowTs, toolEmitter, deltaEvent } = require("./protocol");

// 从用户消息中提取飞书/Lark 文档标识：完整链接，或 doccn 开头的裸 token
const LARK_URL_RE = /(?:https?:\/\/)?[a-zA-Z0-9-]+\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki)\/([A-Za-z0-9]+)/g;
const BARE_TOKEN_RE = /\bdoccn[A-Za-z0-9]{4,}\b/g;

function extractTokens(text) {
  const set = new Set();
  for (const m of String(text).matchAll(LARK_URL_RE)) set.add(m[1]);
  for (const m of String(text).matchAll(BARE_TOKEN_RE)) set.add(m[0]);
  return [...set].slice(0, 3); // 单条消息最多处理 3 篇文档
}

// LLM 上下文预算（字符数近似，防止超大文档把输入撑爆；可调）
const CONTEXT_BUDGET_CHARS = Number(process.env.CONTEXT_BUDGET_CHARS) || 24000;
// 超过该长度的文档不再整篇进上下文，改为按问题节选相关章节
const DOC_FULL_TEXT_MAX = Number(process.env.DOC_FULL_TEXT_MAX) || 8000;

/** 长文档按问题节选：按相关度取 top-k 章节（保持文档原顺序），并附全文大纲 */
function docExcerpt(doc, question, budget) {
  const ranked = splitSections(doc.content)
    .map((s) => ({ ...s, text: s.body.join("\n") }))
    .filter((s) => s.text.trim() && s.text.length <= budget)
    .map((s) => ({ ...s, score: sectionScore(s, question) }))
    .sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const s of ranked) {
    if (used + s.text.length > budget) break;
    picked.push(s);
    used += s.text.length;
  }
  const byIndex = new Map(splitSections(doc.content).map((s, i) => [s, i]));
  picked.sort((a, b) => byIndex.get(a) - byIndex.get(b));
  const body = picked.length
    ? picked.map((s) => `## ${s.heading}\n${s.text}`).join("\n\n")
    : "（未选出与问题直接相关的章节）";
  return `（全文 ${doc.content.length} 字，已按问题节选相关章节）\n\n${body}\n\n**全文大纲**：${outlineOf(doc.content).join(" / ")}`;
}

/** 组装单个文档的上下文块：短文档全文，长文档按问题节选 */
function docBlock(doc, question, budget) {
  const head = `【文档：《${doc.title}》，更新于 ${doc.update_time}，链接 ${doc.url}】\n\n`;
  return head + (doc.content.length <= DOC_FULL_TEXT_MAX ? doc.content : docExcerpt(doc, question, budget));
}

/** 超限类错误识别：网关对超长上下文的报错措辞各异，用关键词兜底判断 */
function isOverflowError(e) {
  return /context|maximum|length|token|too long|too large/i.test(e.message);
}

/** 消息长度估算：字符串取长度，多模态数组只累计文本部分（图片不计入字符预算） */
function contentLen(c) {
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return c.reduce((n, p) => n + (p && typeof p.text === "string" ? p.text.length : 0), 0);
  return 0;
}

/** LLM 模式：文档（长文档按问题节选）+ 预算内的最近对话一起交给模型；提供 onDelta 时走流式 */
async function askLlm(question, session, { onDelta, signal, images = [] } = {}) {
  const docs = Object.values(session.docs);
  const perDocBudget = Math.max(2000, Math.floor((CONTEXT_BUDGET_CHARS * 0.6) / Math.max(1, docs.length)));
  const docBlocks = docs.map((d) => docBlock(d, question, perDocBudget)).join("\n\n---\n\n");

  const system = [
    "你是部署在本地服务里的 Lark 文档问答助手。",
    "系统会通过本地 Lark CLI 抓取用户提供的飞书/Lark 文档，全文附在下方。",
    "要求：",
    "1. 优先依据文档内容回答，引用时注明章节名；文档未覆盖的内容要明确说明，不要编造。",
    "2. 使用 Markdown 输出（标题、列表、表格等）。",
    "3. 始终用中文回答。",
  ].join("\n");

  // 总量超预算时从最旧历史开始丢（文档块优先保留），保底保留最近 2 条。
  // 历史中的图片不重发（避免每轮放大请求）：仅本轮消息携带图片，历史图片消息回落为纯文本。
  let kept = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content || (m.images && m.images.length ? "（图片）" : m.content) }));
  const totalLen = () => system.length + docBlocks.length + kept.reduce((n, m) => n + contentLen(m.content), 0);
  while (kept.length > 2 && totalLen() > CONTEXT_BUDGET_CHARS) kept = kept.slice(1);

  const messages = [
    { role: "system", content: system },
    ...(docBlocks ? [{ role: "system", content: `以下是已读取的文档内容：\n\n${docBlocks}` }] : []),
    ...kept,
  ];

  // 本轮带图片：把最后一条 user 消息（即当前输入）升级为多模态 content（组装逻辑见 images.js）
  if (images.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        messages[i].content = toUserContent(question, images);
        break;
      }
    }
  }

  if (onDelta) return llm.chatStream(messages, { onDelta, signal });
  return llm.chat(messages, { signal });
}

/** 模拟模式假流式：把整段回复切成小块回调，保持与其他模式一致的打字体验 */
async function fakeStream(content, onEvent) {
  const CHUNK = 64;
  for (let i = 0; i < content.length; i += CHUNK) {
    onEvent(deltaEvent(content.slice(i, i + CHUNK)));
    await new Promise((r) => setTimeout(r, 12));
  }
}

/**
 * 内置编排模式：服务端预取文档 → LLM/模拟规则回答。
 * 提供 onEvent 时逐段回调流式事件（契约见 protocol.js）；返回完整回复对象（不写入会话）。
 */
async function builtinCore(message, session, { onEvent, signal, images = [] } = {}) {
  // 1) 工具调用：读取文档（带会话级缓存）
  const toolCalls = [];
  const emitTools = toolEmitter(onEvent, toolCalls);
  for (const token of extractTokens(message)) {
    if (session.docs[token]) {
      toolCalls.push({
        tool: "lark doc get",
        args: token,
        status: "cache",
        summary: `命中会话缓存：《${session.docs[token].title}》`,
      });
      emitTools();
      continue;
    }
    const res = await runLarkCli(["doc", "get", token]);
    if (res.ok) {
      store.cacheDoc(session.id, token, res.data);
      toolCalls.push({
        tool: "lark doc get",
        args: token,
        status: "ok",
        summary: `已读取《${res.data.title}》（${res.data.word_count} 字）`,
      });
    } else {
      toolCalls.push({ tool: "lark doc get", args: token, status: "error", summary: `调用失败：${res.msg}` });
    }
    emitTools();
  }

  // 2) 生成回复：LLM 模式，超限先自愈（丢最早缓存文档重试一次），失败/未配置降级为模拟模式
  let mode = "sim";
  let content;
  if (llmConfig.isConfigured()) {
    const runLlm = () =>
      askLlm(message, session, {
        onDelta: onEvent && ((text) => onEvent(deltaEvent(text))),
        signal,
        images,
      });
    try {
      content = await runLlm();
      mode = "llm";
    } catch (e) {
      if (isOverflowError(e) && Object.keys(session.docs).length) {
        store.dropOldestDoc(session.id);
        try {
          content = await runLlm();
          mode = "llm";
          content = `> ℹ️ 上下文超限，已裁剪最早缓存的文档后重试成功。\n\n` + content;
        } catch {
          /* 自愈失败，走降级 */
        }
      }
      if (mode !== "llm") {
        content = `> ⚠️ LLM 调用失败（${e.message}），已降级为本地模拟回复。\n\n` + buildSimReply(message, session, images);
        if (onEvent) await fakeStream(content, onEvent);
      }
    }
  } else {
    content = buildSimReply(message, session, images);
    if (onEvent) await fakeStream(content, onEvent);
  }

  return makeReply(content, { mode, toolCalls });
}

/**
 * Agent 主流程：记录用户消息 → 按配置的 agentMode 生成回复。
 * - "pi"：pi Agent 模式，规则写入 system prompt，由模型自主调用 lark CLI（专用工具）；
 *   失败自动降级为内置编排。
 * - "builtin"：服务端预取文档 → LLM/模拟规则回答。
 * - 提供 onEvent 时逐段回调流式事件（tool 快照 / delta 增量），供 /api/chat/stream 使用。
 */
/** 首轮回复后异步生成会话短标题：不阻塞回复，失败静默（保留首条消息截断回退） */
function maybeGenerateTitle(session) {
  if (session.title || !llmConfig.isConfigured()) return;
  const firstUser = session.messages.find((m) => m.role === "user");
  if (!firstUser) return;
  llm.chat(
    [
      { role: "system", content: "为用户消息生成一个不超过 12 字的中文会话标题。直接输出标题文本，不要引号、句号或任何前缀说明。" },
      { role: "user", content: String(firstUser.content || "图片提问").slice(0, 300) },
    ],
    { timeoutMs: 10000 }
  )
    .then((t) => {
      const title = String(t).trim().replace(/^["'「」『』《《]+/, "").replace(/[」』》"。．.！!？?，,]+$/, "").trim();
      if (title) store.setTitle(session.id, title);
    })
    .catch(() => {});
}

async function handle(message, session, { onEvent, signal, images = [] } = {}) {
  const userMsg = { role: "user", content: message, ts: nowTs() };
  if (images.length) userMsg.images = images; // 图片仅内存（落盘时剥离，见 store.persist），刷新后不回显
  store.appendMessages(session.id, [userMsg]);

  let reply;
  if (llmConfig.publicConfig().agentMode === "pi") {
    try {
      reply = await piAgent.run(message, session.id, { onEvent, signal, images });
    } catch (e) {
      const base = await builtinCore(message, session, { onEvent, signal, images });
      const note = `> ⚠️ pi Agent 调用失败（${e.message}），已降级为内置模式。\n\n`;
      reply = makeReply(note + base.content, { mode: base.mode, toolCalls: base.toolCalls });
    }
  } else {
    reply = await builtinCore(message, session, { onEvent, signal, images });
  }

  store.appendMessages(session.id, [reply]);
  maybeGenerateTitle(session);
  return reply;
}

// 导出 handle（对外接口）+ 纯函数（内部测试接缝，供 test/ 直接验证）；模拟回答与章节匹配见 sim-reply.js
module.exports = { handle, extractTokens, docExcerpt, isOverflowError };
