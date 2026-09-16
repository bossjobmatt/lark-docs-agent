/** 入口：初始化（健康检查 → 示例文档 → 历史恢复/欢迎页）。各模块自行注册各自的事件。 */
import { state } from "./js/state.js";
import { escapeHtml } from "./js/ui.js";
import { refreshHealth } from "./js/health.js";
import { refresh, showWelcome, composerPrefill } from "./js/chat.js";
import "./js/sessions.js";
import "./js/llm-modal.js";

const chatEl = document.getElementById("chat");
const examplesEl = document.getElementById("examples");
const input = document.getElementById("input");

(async function init() {
  await refreshHealth();

  try {
    const { items } = await fetch("/api/examples").then((r) => r.json());
    // 未检测到 lark CLI（或列表为空）时隐藏整行提示，避免出现悬空标签
    if (!items || !items.length) {
      document.getElementById("tips").classList.add("hidden");
    }
    for (const d of items || []) {
      const chip = document.createElement("button");
      chip.className = "example-chip";
      chip.type = "button";
      chip.textContent = `📄 ${d.title}`;
      chip.title = d.url;
      chip.addEventListener("click", () => composerPrefill(`帮我总结这篇文档：${d.url}`));
      examplesEl.appendChild(chip);
    }
  } catch {
    document.getElementById("tips").classList.add("hidden");
  }

  // 流式进行中不做任何初始化渲染：晚到的 refresh 或欢迎页都会破坏正在生成的消息流
  if (state.busy) return;
  if (state.sessionId) {
    try {
      const { messages } = await fetch(`/api/history?sessionId=${encodeURIComponent(state.sessionId)}`).then((r) => r.json());
      if (messages.length) {
        refresh(messages);
        return;
      }
    } catch { /* 落到欢迎页 */ }
  }
  const lark = state.lastHealth && state.lastHealth.lark;
  showWelcome(lark ? lark.available : true);
})();
