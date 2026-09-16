/** 会话管理面板：列表、切换、新建、删除 */
import { el, escapeHtml } from "./ui.js";
import { state } from "./state.js";
import { post } from "./api.js";
import { refresh, showWelcome } from "./chat.js";
import { abortStream } from "./stream.js";
import { refreshHealth } from "./health.js";

const sessionsBtn = document.getElementById("sessions-btn");
const sessionsPanel = document.getElementById("sessions-panel");

function openSessions() {
  sessionsPanel.classList.remove("hidden");
  sessionsPanel.innerHTML = '<div class="session-loading">加载中…</div>';
  fetch("/api/sessions")
    .then((r) => r.json())
    .then(({ sessions }) => renderSessions(sessions || []))
    .catch((e) => (sessionsPanel.innerHTML = `<div class="session-loading">加载失败：${escapeHtml(e.message)}</div>`));
}

function renderSessions(list) {
  sessionsPanel.innerHTML = "";
  const newBtn = el("button", "session-new");
  newBtn.type = "button";
  newBtn.textContent = "＋ 新建会话";
  newBtn.addEventListener("click", startNewSession);
  sessionsPanel.appendChild(newBtn);

  for (const s of list) {
    const item = el("div", "session-item" + (s.id === state.sessionId ? " current" : ""));
    const main = el("button", "session-main");
    main.type = "button";
    const title = el("span", "session-title");
    title.textContent = s.title;
    const meta = el("span", "session-meta");
    meta.textContent = `${s.messageCount} 条 · ${new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false })}`;
    main.appendChild(title);
    main.appendChild(meta);
    main.addEventListener("click", () => switchSession(s.id));
    const del = el("button", "session-del");
    del.type = "button";
    del.title = "删除该会话";
    del.textContent = "×";
    del.addEventListener("click", () => deleteSession(s.id));
    item.appendChild(main);
    item.appendChild(del);
    sessionsPanel.appendChild(item);
  }
  if (!list.length) {
    const empty = el("div", "session-loading");
    empty.textContent = "暂无历史会话";
    sessionsPanel.appendChild(empty);
  }
}

async function switchSession(id) {
  if (state.busy) abortStream(); // 先中止当前生成，避免流式内容跨会话写入
  state.sessionId = id;
  localStorage.setItem("lark-docs-session", id);
  sessionsPanel.classList.add("hidden");
  try {
    const { messages } = await fetch(`/api/history?sessionId=${encodeURIComponent(id)}`).then((r) => r.json());
    refresh(messages);
  } catch {
    refresh([]);
  }
  refreshHealth();
}

function startNewSession() {
  if (state.busy) abortStream();
  state.sessionId = null;
  localStorage.removeItem("lark-docs-session");
  sessionsPanel.classList.add("hidden");
  refresh([]);
}

async function deleteSession(id) {
  if (!window.confirm("删除该会话？此操作不可恢复。")) return;
  if (state.busy && id === state.sessionId) abortStream();
  try {
    await post("/api/session/delete", { sessionId: id });
  } catch {
    /* 服务端删除失败也继续本地清理 */
  }
  if (id === state.sessionId) return startNewSession();
  openSessions(); // 刷新列表
}

sessionsBtn.addEventListener("click", () => {
  if (sessionsPanel.classList.contains("hidden")) openSessions();
  else sessionsPanel.classList.add("hidden");
});
document.addEventListener("click", (e) => {
  if (sessionsPanel.classList.contains("hidden")) return;
  if (sessionsPanel.contains(e.target) || sessionsBtn.contains(e.target)) return;
  sessionsPanel.classList.add("hidden");
});
