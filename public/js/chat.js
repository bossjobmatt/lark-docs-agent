/** 聊天主界面：消息渲染、流式发送（增量渲染/停止）、输入区与清空 */
import { el, escapeHtml, toolChipsEl, frontendMarkdown, scrollBottom } from "./ui.js";
import { state } from "./state.js";
import { post } from "./api.js";
import { refreshHealth } from "./health.js";

const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear-btn");

let streamAbort = null;

function setBusy(v) {
  state.busy = v;
  // 发送键在生成期间变为「⏹ 停止」；输入框保持可编辑，方便预写下一条问题
  sendBtn.textContent = v ? "⏹ 停止" : "发送";
  sendBtn.classList.toggle("stop", v);
}

export function abortStream() {
  if (streamAbort) streamAbort.abort();
}

function renderMessage(m) {
  const wrap = el("div", `msg ${m.role}`);

  if (m.toolCalls && m.toolCalls.length) {
    wrap.appendChild(toolChipsEl(m.toolCalls));
  }

  const bubble = el("div", "bubble");
  if (m.role === "assistant") {
    bubble.innerHTML = m.html || escapeHtml(m.content || "");
  } else {
    bubble.textContent = m.content;
  }

  if (m.role === "assistant" && m.content) {
    // 回答卡片：气泡 + 底部操作条（复制 Markdown 原文 / Raw 与渲染切换）
    const holder = el("div", "bubble-block");
    holder.appendChild(bubble);

    const actions = el("div", "bubble-actions");

    const copyBtn = el("button", "mini-action");
    copyBtn.type = "button";
    copyBtn.title = "复制 Markdown 原文";
    copyBtn.textContent = "⧉ 复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(m.content);
        copyBtn.textContent = "✓ 已复制";
      } catch {
        copyBtn.textContent = "复制失败";
      }
      setTimeout(() => (copyBtn.textContent = "⧉ 复制"), 1500);
    });
    actions.appendChild(copyBtn);

    const rawBtn = el("button", "mini-action");
    rawBtn.type = "button";
    rawBtn.title = "在 Markdown 源码与渲染视图间切换";
    rawBtn.textContent = "Raw";
    let showRaw = false;
    rawBtn.addEventListener("click", () => {
      showRaw = !showRaw;
      bubble.innerHTML = showRaw
        ? `<pre class="raw-md">${escapeHtml(m.content)}</pre>`
        : m.html || escapeHtml(m.content);
      rawBtn.textContent = showRaw ? "渲染" : "Raw";
      rawBtn.classList.toggle("active", showRaw);
    });
    actions.appendChild(rawBtn);

    holder.appendChild(actions);
    wrap.appendChild(holder);
  } else {
    wrap.appendChild(bubble);
  }

  if (m.ts) {
    const ts = el("span", "ts");
    ts.textContent = m.ts;
    wrap.appendChild(ts);
  }
  return wrap;
}

export function refresh(history) {
  chatEl.innerHTML = "";
  for (const m of history) chatEl.appendChild(renderMessage(m));
  if (!history.length) showWelcome();
  scrollBottom(true);
}

export function showWelcome(larkAvailable = true) {
  const larkHint = larkAvailable
    ? ""
    : '<p style="color:#b45309">⚠️ 未检测到本地已认证的 lark CLI——解析飞书/Lark 文档需要本地安装并完成认证（<code>LARK_CLI</code> 环境变量或 PATH 中的 <code>lark</code>）。安装后重启本服务即可。</p>';
  chatEl.appendChild(
    renderMessage({
      role: "assistant",
      content: null,
      html:
        "<p>你好！我是 <b>Lark 文档助手</b> 🤖</p>" +
        "<p>把 <b>飞书/Lark 文档链接</b> 和你的问题一起发给我，我会调用本地 Lark CLI 读取文档后回答，并支持多轮追问。</p>" +
        larkHint +
        "<p>试试点击下方的示例文档，或粘贴：<code>https://demo.feishu.cn/docx/doccnABC123xyz</code></p>",
    })
  );
}

/** 示例文档点击：预填输入框并聚焦（由入口模块调用） */
export function composerPrefill(text) {
  input.value = text;
  input.focus();
  input.dispatchEvent(new Event("input"));
}

async function handleSend(text) {
  setBusy(true);
  chatEl.appendChild(renderMessage({ role: "user", content: text }));
  const typing = el("div", "typing");
  typing.textContent = "Agent 处理中（提取链接 → 调用 Lark CLI → 生成回复）";
  chatEl.appendChild(typing);
  scrollBottom(true);

  try {
    await sendStreaming(text, typing);
  } catch (e) {
    typing.remove();
    const errWrap = el("div", "msg assistant");
    errWrap.appendChild(renderMessage({ role: "assistant", content: `❌ 请求失败：${e.message}` }));
    const retry = el("button", "retry-chip");
    retry.type = "button";
    retry.textContent = "↻ 重试这条消息";
    retry.addEventListener("click", () => {
      retry.closest(".msg").remove();
      handleSend(text);
    });
    errWrap.appendChild(retry);
    chatEl.appendChild(errWrap);
    scrollBottom(true);
  } finally {
    setBusy(false);
    input.focus();
  }
}

/**
 * 流式发送：POST /api/chat/stream，按行读 NDJSON 事件。
 * 事件契约定义见 src/protocol.js（start / tool / delta / done / error）。
 * 流式期间用前端 marked 增量渲染（节流 ~90ms），done 后整体替换为服务端渲染的完整卡片；
 * 点击「⏹ 停止」中止生成——已生成的部分仅保留在当前页面（服务端不持久化半截回复）。
 */
function sendStreaming(text, typing) {
  streamAbort = new AbortController();
  let userAborted = false;
  streamAbort.signal.addEventListener("abort", () => (userAborted = true), { once: true });

  const run = async () => {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
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
    const paint = (force) => {
      const now = Date.now();
      if (!force && now - lastPaint < 90) return; // 节流：约 90ms 渲染一次，避免每个增量都重解析
      lastPaint = now;
      bubble.innerHTML = frontendMarkdown(content) || escapeHtml(content);
      scrollBottom();
    };

    const onEvent = (evt) => {
      if (evt.type === "start") {
        state.sessionId = evt.sessionId;
        localStorage.setItem("lark-docs-session", state.sessionId);
      } else if (evt.type === "tool") {
        if (typing.parentNode) typing.textContent = "已读取文档，正在生成回复…";
        if (!toolsEl) {
          toolsEl = el("div", "toolcalls");
          wrap.insertBefore(toolsEl, bubble);
        }
        toolsEl.innerHTML = "";
        toolsEl.appendChild(toolChipsEl(evt.toolCalls || []));
        scrollBottom();
      } else if (evt.type === "delta") {
        if (typing.parentNode) typing.remove();
        content += evt.text;
        paint(false);
      } else if (evt.type === "done") {
        finished = true;
        if (typing.parentNode) typing.remove();
        wrap.replaceWith(renderMessage(evt.reply));
        refreshHealth();
        scrollBottom(true);
      } else if (evt.type === "error") {
        if (typing.parentNode) typing.remove();
        bubble.classList.remove("streaming");
        content += (content ? "\n\n" : "") + `❌ ${evt.error}`;
        errMsg = evt.error;
        paint(true);
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
      if (!userAborted) throw e; // 用户主动停止 → 优雅收尾；其余异常向上抛
    }
    streamAbort = null;

    if (!finished && !errMsg && !userAborted) throw new Error("流式连接提前结束");
    if (userAborted) {
      if (typing.parentNode) typing.remove();
      bubble.classList.remove("streaming");
      content += content ? "\n\n> ⏹ 已停止生成" : "⏹ 已停止生成";
      paint(true);
    }
  };

  return run().catch((e) => {
    streamAbort = null;
    throw e;
  });
}

// ---------- 输入区事件 ----------
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) {
    abortStream(); // 生成期间发送键即「⏹ 停止」
    return;
  }
  const text = input.value.trim();
  if (!text) return;
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
