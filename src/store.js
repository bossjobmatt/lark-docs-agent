const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { renderMarkdown } = require("./markdown");

// 会话持久化到 data/sessions.json，服务重启后多轮对话不丢。
// 控制存储体积的约定：
// - 落盘只存紧凑 JSON 与消息的 Markdown 原文（html 渲染结果加载时现算，docs 缓存只在内存）
// - 每会话最多保留最近 SESSION_MAX_MESSAGES 条消息，docs 缓存最多 MAX_DOCS 篇
// - 会话自动淘汰：不活跃超过 SESSION_TTL_DAYS 天、或总数超过 SESSION_MAX_COUNT 即删
const DATA_FILE = path.join(__dirname, "..", "data", "sessions.json");
const TTL_MS = (Number(process.env.SESSION_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = Number(process.env.SESSION_MAX_COUNT) || 100;
const MAX_MESSAGES = Number(process.env.SESSION_MAX_MESSAGES) || 50;
const MAX_DOCS = 20;

const sessions = new Map();

// html 不落盘：加载时按 Markdown 原文补算，与运行时行为保持一致
function rehydrateHtml(m) {
  if (m.role === "assistant" && m.content && !m.html) m.html = renderMarkdown(m.content);
  return m;
}

function lastActive(s) {
  return Date.parse(s.updatedAt || s.createdAt || 0);
}

try {
  const now = Date.now();
  for (const s of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) {
    if (!s || !s.id) continue;
    const updatedAt = s.updatedAt || s.createdAt || new Date(0).toISOString();
    if (now - Date.parse(updatedAt) > TTL_MS) continue; // 启动时淘汰长期不活跃会话
    sessions.set(s.id, {
      id: s.id,
      createdAt: s.createdAt || updatedAt,
      updatedAt,
      messages: (s.messages || []).slice(-MAX_MESSAGES).map(rehydrateHtml),
      docs: {}, // docs 缓存只在内存，重启后同文档会重调 CLI
    });
  }
} catch {
  /* 首次运行无历史数据 */
}

function trim(session) {
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
  const tokens = Object.keys(session.docs);
  for (const t of tokens.slice(0, Math.max(0, tokens.length - MAX_DOCS))) {
    delete session.docs[t];
  }
}

function evict() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - lastActive(s) > TTL_MS) sessions.delete(id);
  }
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => lastActive(a[1]) - lastActive(b[1]))
      .slice(0, sessions.size - MAX_SESSIONS);
    for (const [id] of oldest) sessions.delete(id);
  }
}

function touch(session) {
  session.updatedAt = new Date().toISOString();
  trim(session);
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const slim = [...sessions.values()].map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: s.messages.map(({ html, ...rest }) => rest), // html 不落盘
      }));
      fs.writeFileSync(DATA_FILE, JSON.stringify(slim)); // 紧凑存储，不带缩进
    } catch (e) {
      console.error("[store] 持久化失败:", e.message);
    }
  }, 300);
}

// 定期清理：让 TTL 淘汰在服务空闲时也能落盘生效
const sweepTimer = setInterval(() => {
  evict();
  persist();
}, 60 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

function create() {
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    messages: [], // [{ role: "user"|"assistant", content, html?, toolCalls?, mode?, ts }]
    docs: {}, // token -> lark CLI 拉取的文档缓存（避免同会话重复调 CLI）
  };
  sessions.set(session.id, session);
  evict();
  persist();
  return session;
}

const get = (id) => {
  const session = (id && sessions.get(id)) || null;
  if (session) touch(session);
  return session;
};
const getOrCreate = (id) => get(id) || create();

function clear(id) {
  const session = get(id);
  if (session) {
    session.messages = [];
    session.docs = {};
    persist();
  }
  return session;
}

module.exports = { getOrCreate, get, clear, persist };
