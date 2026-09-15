const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 会话持久化到 data/sessions.json，服务重启后多轮对话不丢
const DATA_FILE = path.join(__dirname, "..", "data", "sessions.json");
const sessions = new Map();

try {
  for (const s of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) sessions.set(s.id, s);
} catch {
  /* 首次运行无历史数据 */
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...sessions.values()], null, 2));
    } catch (e) {
      console.error("[store] 持久化失败:", e.message);
    }
  }, 300);
}

function create() {
  const session = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messages: [], // [{ role: "user"|"assistant", content, html?, toolCalls?, mode?, ts }]
    docs: {}, // token -> lark CLI 拉取的文档缓存（避免同会话重复调 CLI）
  };
  sessions.set(session.id, session);
  persist();
  return session;
}

const get = (id) => (id && sessions.get(id)) || null;
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
