/** 流式发送：POST /api/chat/stream（NDJSON 事件解析）、流式增量渲染、生成中止。
 *  事件契约定义见 src/protocol.js（start / tool / delta / done / error）。
 *  流式期间按「稳定前缀 + 活跃尾行」增量渲染（节流 ~90ms），done 后整体替换为服务端权威渲染；
 *  点击「⏹ 停止」中止生成——已生成的部分仅保留在当前页面（服务端不持久化半截回复）。 */
import { el, escapeHtml, toolChipsEl, frontendMarkdown, streamingMarkdown, renderMessage, scrollBottom } from "./ui.js";
import { state } from "./state.js";
import { refreshHealth } from "./health.js";

const chatEl = document.getElementById("chat");

let streamAbort = null;

export function abortStream() {
  if (streamAbort) streamAbort.abort();
}

function sendStreaming(text, typing, stageHint, images = []) {
  streamAbort = new AbortController();
  let userAborted = false;
  streamAbort.signal.addEventListener("abort", () => (userAborted = true), { once: true });

  const run = async () => {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text, images }),
      signal: streamAbort.signal,
    });
    if (!resp.ok || !(resp.headers.get("content-type") || "").includes("ndjson")) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const wrap = el("div", "msg assistant");
    const bubble = el("div", "bubble streaming");
    wrap.appendChild(bubble);
    chatEl.appendChild(wrap);
    scrollBottom();

    let toolsEl = null;
    let finished = false;
    let errMsg = null;
    let content = "";
    let lastPaint = 0;

    // 节流：约 90ms 渲染一次，避免每个增量都重解析；稳定前缀走 marked，未完行纯文本尾随
    const paint = (force, fullRender) => {
      const now = Date.now();
      if (!force && now - lastPaint < 90) return;
      lastPaint = now;
      bubble.innerHTML = fullRender
        ? frontendMarkdown(content) || escapeHtml(content)
        : streamingMarkdown(content) ?? escapeHtml(content);
      scrollBottom();
    };

    const onEvent = (evt) => {
      if (evt.type === "start") {
        state.sessionId = evt.sessionId;
        localStorage.setItem("lark-docs-session", state.sessionId);
      } else if (evt.type === "tool") {
        if (typing.parentNode) typing.textContent = "已读取文档，正在生成回复…";
        stageHint.rearm();
        if (!toolsEl) {
          toolsEl = el("div", "toolcalls");
          wrap.insertBefore(toolsEl, bubble);
        }
        toolsEl.innerHTML = "";
        toolsEl.appendChild(toolChipsEl(evt.toolCalls || []));
        scrollBottom();
      } else if (evt.type === "delta") {
        stageHint.rearm(); // 流中停顿同样纳入 2s「等待模型响应…」提示
        if (typing.parentNode) typing.classList.add("hidden"); // 正文出现即让位，停顿时复用
        content += evt.text;
        paint(false);
      } else if (evt.type === "done") {
        stageHint.clear();
        finished = true;
        if (typing.parentNode) typing.remove();
        wrap.replaceWith(renderMessage(evt.reply));
        refreshHealth();
        scrollBottom(true);
      } else if (evt.type === "error") {
        stageHint.clear();
        if (typing.parentNode) typing.remove();
        bubble.classList.remove("streaming");
        content += (content ? "\n\n" : "") + `❌ ${evt.error}`;
        errMsg = evt.error;
        paint(true, true); // 终态：整体走权威渲染，不再有后续增量
      }
    };

    try {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          onEvent(evt);
        }
      }
    } catch (e) {
      stageHint.clear();
      if (!userAborted) throw e; // 用户主动停止 → 优雅收尾；其余异常向上抛
    }
    streamAbort = null;

    if (!finished && !errMsg && !userAborted) throw new Error("流式连接提前结束");
    if (userAborted) {
      if (typing.parentNode) typing.remove();
      bubble.classList.remove("streaming");
      content += content ? "\n\n> ⏹ 已停止生成" : "⏹ 已停止生成";
      paint(true, true); // 终态：整体走权威渲染
    }
  };

  return run().catch((e) => {
    streamAbort = null;
    throw e;
  });
}

export { sendStreaming };
