/** 聊天主界面：消息流管理、发送入口（流式实现在 stream.js）、输入区与清空 */
import { el, renderMessage, scrollBottom } from "./ui.js";
import { state } from "./state.js";
import { post } from "./api.js";
import { sendStreaming, abortStream } from "./stream.js";
import { enterChat, enterWelcome } from "./welcome.js";
import { count as attachCount, take as takeAttachments } from "./attach.js";

const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear-btn");

function setBusy(v) {
  state.busy = v;
  // 发送键在生成期间变为「⏹ 停止」；输入框保持可编辑，方便预写下一条问题
  sendBtn.textContent = v ? "⏹ 停止" : "发送";
  sendBtn.classList.toggle("stop", v);
}

export { abortStream };

export function refresh(history) {
  chatEl.innerHTML = "";
  for (const m of history) chatEl.appendChild(renderMessage(m));
  // 空历史进欢迎态（输入框居中），非空历史确保退出欢迎态（切会话/清空后均经此处收敛布局）
  if (history.length) enterChat();
  else enterWelcome();
  scrollBottom(true);
}

async function handleSend(text, images = takeAttachments()) {
  enterChat(); // 首条消息发出即从居中欢迎态切回吸底输入
  setBusy(true);
  chatEl.appendChild(renderMessage({ role: "user", content: text, images }));
  const typing = el("div", "typing");
  typing.textContent = "Agent 处理中（提取链接 → 调用 Lark CLI → 生成回复）";
  chatEl.appendChild(typing);
  scrollBottom(true);

  // 阶段超时提示：从发送即计时（覆盖等待响应头阶段），每个阶段转换重置，2s 无新事件提示「等待模型响应…」。
  // 流式开始后 typing 元素不销毁（仅隐藏），流中停顿时复用同一提示。
  const showWaitHint = () => {
    if (!typing.parentNode) return;
    typing.classList.remove("hidden");
    typing.textContent = "等待模型响应…";
  };
  const stageHint = {
    timer: setTimeout(showWaitHint, 2000),
    rearm() {
      clearTimeout(stageHint.timer);
      stageHint.timer = setTimeout(showWaitHint, 2000);
    },
    clear() {
      clearTimeout(stageHint.timer);
    },
  };

  try {
    await sendStreaming(text, typing, stageHint, images);
  } catch (e) {
    typing.remove();
    const errWrap = el("div", "msg assistant");
    errWrap.appendChild(renderMessage({ role: "assistant", content: `❌ 请求失败：${e.message}` }));
    const retry = el("button", "retry-chip");
    retry.type = "button";
    retry.textContent = "↻ 重试这条消息";
    retry.addEventListener("click", () => {
      retry.closest(".msg").remove();
      handleSend(text, images); // 连同图片一起重发
    });
    errWrap.appendChild(retry);
    chatEl.appendChild(errWrap);
    scrollBottom(true);
  } finally {
    stageHint.clear();
    setBusy(false);
    input.focus();
  }
}

// ---------- 输入区事件 ----------
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) {
    abortStream(); // 生成期间发送键即「⏹ 停止」
    return;
  }
  const text = input.value.trim();
  if (!text && !attachCount()) return; // 允许纯图片消息
  input.value = "";
  input.style.height = "auto";
  handleSend(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

clearBtn.addEventListener("click", async () => {
  if (state.sessionId) {
    try {
      await post("/api/session/clear", { sessionId: state.sessionId });
    } catch { /* 忽略，本地重置即可 */ }
  }
  refresh([]);
});
