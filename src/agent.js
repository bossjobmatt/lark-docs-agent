const { runLarkCli } = require("./lark");
const llm = require("./llm");
const piAgent = require("./pi-agent");
const { renderMarkdown } = require("./markdown");

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

/** LLM 模式：把 CLI 拉到的文档全文 + 最近对话上下文一起交给模型 */
async function askLlm(question, session) {
  const docBlocks = Object.values(session.docs)
    .map(
      (d) =>
        `【文档：《${d.title}》，更新于 ${d.update_time}，链接 ${d.url}】\n\n${d.content}`
    )
    .join("\n\n---\n\n");

  const system = [
    "你是部署在本地服务里的 Lark 文档问答助手。",
    "系统会通过本地 Lark CLI 抓取用户提供的飞书/Lark 文档，全文附在下方。",
    "要求：",
    "1. 优先依据文档内容回答，引用时注明章节名；文档未覆盖的内容要明确说明，不要编造。",
    "2. 使用 Markdown 输出（标题、列表、表格等）。",
    "3. 始终用中文回答。",
  ].join("\n");

  const history = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: "system", content: system },
    ...(docBlocks ? [{ role: "system", content: `以下是已读取的文档内容：\n\n${docBlocks}` }] : []),
    ...history,
  ];
  return llm.chat(messages);
}

/**
 * 内置编排模式：服务端预取文档 → LLM/模拟规则回答。
 * 返回 { role, content, html, toolCalls, mode, ts }（不写入会话）。
 */
async function builtinCore(message, session) {
  // 1) 工具调用：读取文档（带会话级缓存）
  const toolCalls = [];
  for (const token of extractTokens(message)) {
    if (session.docs[token]) {
      toolCalls.push({
        tool: "lark doc get",
        args: token,
        status: "cache",
        summary: `命中会话缓存：《${session.docs[token].title}》`,
      });
      continue;
    }
    const res = await runLarkCli(["doc", "get", token]);
    if (res.ok) {
      session.docs[token] = res.data;
      toolCalls.push({
        tool: "lark doc get",
        args: token,
        status: "ok",
        summary: `已读取《${res.data.title}》（${res.data.word_count} 字）`,
      });
    } else {
      toolCalls.push({ tool: "lark doc get", args: token, status: "error", summary: `调用失败：${res.msg}` });
    }
  }

  // 2) 生成回复：LLM 模式，失败/未配置则降级为模拟模式
  let mode = "sim";
  let content;
  if (llm.isConfigured()) {
    try {
      content = await askLlm(message, session);
      mode = "llm";
    } catch (e) {
      content = `> ⚠️ LLM 调用失败（${e.message}），已降级为本地模拟回复。\n\n` + buildSimReply(message, session);
    }
  } else {
    content = buildSimReply(message, session);
  }

  return {
    role: "assistant",
    content,
    html: renderMarkdown(content),
    toolCalls,
    mode,
    ts: new Date().toLocaleString("zh-CN", { hour12: false }),
  };
}

/**
 * Agent 主流程：记录用户消息 → 按配置的 agentMode 生成回复。
 * - "pi"：pi Agent 模式，规则写入 system prompt，由模型自主调用 lark CLI（专用工具）；
 *   失败自动降级为内置编排。
 * - "builtin"：服务端预取文档 → LLM/模拟规则回答。
 */
async function handle(message, session) {
  session.messages.push({
    role: "user",
    content: message,
    ts: new Date().toLocaleString("zh-CN", { hour12: false }),
  });

  let reply;
  if (llm.publicConfig().agentMode === "pi") {
    try {
      const r = await piAgent.run(message, session.id);
      reply = {
        role: "assistant",
        content: r.content,
        html: r.html,
        toolCalls: r.toolCalls,
        mode: "pi",
        ts: new Date().toLocaleString("zh-CN", { hour12: false }),
      };
    } catch (e) {
      reply = await builtinCore(message, session);
      const note = `> ⚠️ pi Agent 调用失败（${e.message}），已降级为内置模式。\n\n`;
      reply.content = note + reply.content;
      reply.html = renderMarkdown(reply.content);
    }
  } else {
    reply = await builtinCore(message, session);
  }

  session.messages.push(reply);
  return reply;
}

module.exports = { handle };
