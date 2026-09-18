/** 入口：初始化（健康检查 → 历史恢复/欢迎页）。各模块自行注册各自的事件。 */
import { state } from "./js/state.js";
import { refresh } from "./js/chat.js";
import { enterWelcome } from "./js/welcome.js";
import { refreshHealth } from "./js/health.js";
import "./js/sessions.js";
import "./js/llm-modal.js";

(async function init() {
  await refreshHealth();

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
  enterWelcome(lark ? lark.available : true);
})();
