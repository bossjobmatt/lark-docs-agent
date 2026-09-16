const { runLarkCli } = require("./lark");
const llm = require("./llm");
const llmConfig = require("./llm-config");
const piAgent = require("./pi-agent");
const store = require("./store");
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

function stripUrls(text) {
  // 只移除 URL 本身（域名字符 + 路径中的字母数字），不能贪吃到后续中文文本
  return String(text)
    .replace(/(?:https?:\/\/)?[a-zA-Z0-9-]+\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)(?:\/[A-Za-z0-9]+)+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把 Markdown 按二级标题切片，用于模拟模式下按问题定位章节 */
function splitSections(md) {
  const sections = [];
  let cur = { heading: "开篇", body: [] };
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{2,6})\s+(.*)/);
    if (h) {
      if (cur.body.join("").trim()) sections.push(cur);
      cur = { heading: h[2].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join("").trim()) sections.push(cur);
  return sections;
}

/** 粗略关键词匹配打分：标题命中权重 x3，正文按 2-gram/词命中累计 */
function sectionScore(section, question) {
  const heading = section.heading.toLowerCase();
  const body = section.body.join("\n").toLowerCase();
  const cleaned = question.toLowerCase().replace(/[，。？！、,.?!（）()：:"'\s]+/g, " ");
  const grams = new Set();
  for (const w of cleaned.split(" ")) {
    if (w.length < 2) continue;
    grams.add(w);
    for (let i = 0; i < w.length - 1; i++) grams.add(w.slice(i, i + 2));
  }
  let score = 0;
  for (const g of grams) {
    if (heading.includes(g)) score += g.length * 3;
    if (body.includes(g)) score += g.length;
  }
  return score;
}

function outlineOf(md) {
  return md
    .split("\n")
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());
}

function excerpt(text, max = 420) {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + " …（截断）" : t;
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

/** 无 LLM 时的本地模拟回复：证明「取文档→回答」链路可用 */
function buildSimReply(question, session) {
  const docs = Object.values(session.docs);

  if (!docs.length) {
    return [
      "你好！我是 **Lark 文档助手** 🤖，当前为**模拟模式**（未配置大模型 Key，回复由本地规则生成，用于演示完整链路）。",
      "",
      "工作流程：",
      "1. 在消息中粘贴飞书/Lark 文档链接（支持 feishu.cn / larksuite.com / larkoffice.com，也可直接输入 `doccn` 开头的 token）；",
      "2. 我会调用本地 Lark CLI（`lark doc get <链接>`）读取文档全文；",
      "3. 基于文档内容回答你的问题，同一会话内支持多轮追问，文档内容已缓存、不会重复拉取。",
      "",
      "试试：`帮我总结这份文档：https://demo.feishu.cn/docx/doccnABC123xyz`",
      "",
      "💡 配置 `LLM_API_KEY`（OpenAI 兼容）并重启服务，可获得真正的 AI 问答效果。",
    ].join("\n");
  }

  const parts = [
    `已读取 **${docs.length}** 篇文档（当前为**模拟模式**，回答由本地规则匹配生成，仅供演示链路）：`,
    "",
  ];
  let anyMatch = false;

  for (const doc of docs) {
    const sections = splitSections(doc.content);
    const q = stripUrls(question) || "请总结这篇文档";
    let best = null;
    let bestScore = 0;
    for (const s of sections) {
      const score = sectionScore(s, q);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }

    parts.push(`---`, ``, `### 📄 《${doc.title}》`);
    if (best && bestScore >= 4) {
      anyMatch = true;
      parts.push(
        `**针对你的问题「${q.slice(0, 40)}」，定位到章节：${best.heading}**`,
        ``,
        excerpt(best.body.join("\n"))
      );
    } else {
      parts.push(`> 文档中没有找到与该问题直接相关的段落，以下是大纲供参考：`);
    }
    parts.push(``, `**文档大纲**：${outlineOf(doc.content).join(" / ")}`, ``);
  }

  parts.push(
    `---`,
    `多轮提示：你可以继续追问，例如「上线流程有哪些步骤？」「里程碑计划是什么？」（文档已在本会话缓存）。`
  );
  if (!anyMatch) parts.push(`提示：换一个与文档内容更相关的问题试试，或先发送文档链接。`);
  return parts.join("\n");
}

/** LLM 模式：文档（长文档按问题节选）+ 预算内的最近对话一起交给模型；提供 onDelta 时走流式 */
async function askLlm(question, session, { onDelta, signal } = {}) {
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

  // 总量超预算时从最旧历史开始丢（文档块优先保留），保底保留最近 2 条
  let kept = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));
  const totalLen = () => system.length + docBlocks.length + kept.reduce((n, m) => n + m.content.length, 0);
  while (kept.length > 2 && totalLen() > CONTEXT_BUDGET_CHARS) kept = kept.slice(1);

  const messages = [
    { role: "system", content: system },
    ...(docBlocks ? [{ role: "system", content: `以下是已读取的文档内容：\n\n${docBlocks}` }] : []),
    ...kept,
  ];
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
async function builtinCore(message, session, { onEvent, signal } = {}) {
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
        content = `> ⚠️ LLM 调用失败（${e.message}），已降级为本地模拟回复。\n\n` + buildSimReply(message, session);
        if (onEvent) await fakeStream(content, onEvent);
      }
    }
  } else {
    content = buildSimReply(message, session);
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
async function handle(message, session, { onEvent, signal } = {}) {
  store.appendMessages(session.id, [{ role: "user", content: message, ts: nowTs() }]);

  let reply;
  if (llmConfig.publicConfig().agentMode === "pi") {
    try {
      reply = await piAgent.run(message, session.id, { onEvent, signal });
    } catch (e) {
      const base = await builtinCore(message, session, { onEvent, signal });
      const note = `> ⚠️ pi Agent 调用失败（${e.message}），已降级为内置模式。\n\n`;
      reply = makeReply(note + base.content, { mode: base.mode, toolCalls: base.toolCalls });
    }
  } else {
    reply = await builtinCore(message, session, { onEvent, signal });
  }

  store.appendMessages(session.id, [reply]);
  return reply;
}

// 导出 handle（对外接口）+ 纯函数（内部测试接缝，供 test/ 直接验证）
module.exports = { handle, extractTokens, splitSections, sectionScore, docExcerpt, isOverflowError };
