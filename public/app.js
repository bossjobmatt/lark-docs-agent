const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear-btn");
const badgeEl = document.getElementById("mode-badge");
const examplesEl = document.getElementById("examples");

const llmModal = document.getElementById("llm-modal");
const llmBtn = document.getElementById("llm-btn");
const llmType = document.getElementById("llm-type");
const llmBase = document.getElementById("llm-base");
const llmKey = document.getElementById("llm-key");
const llmModel = document.getElementById("llm-model");
const llmMsg = document.getElementById("llm-msg");
const llmFetchBtn = document.getElementById("llm-fetch-models");
const llmModelSelect = document.getElementById("llm-model-select");
const llmManualBtn = document.getElementById("llm-manual-model");
const llmAgentMode = document.getElementById("llm-agent-mode");

let sessionId = localStorage.getItem("lark-docs-session") || null;
let busy = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

/** 工具调用徽标列表（流式与非流式渲染共用） */
function toolChipsEl(toolCalls) {
  const tools = el("div", "toolcalls");
  for (const t of toolCalls) {
    const chip = el("span", `tool ${t.status || ""}`);
    const icon = t.status === "ok" ? "🛠" : t.status === "cache" ? "⚡" : t.status === "error" ? "❌" : "🛠";
    chip.textContent = `${icon} $ ${t.tool} ${t.args} — ${t.summary}`;
    tools.appendChild(chip);
  }
  return tools;
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

function scrollBottom() {
  // 消息区跟随 body 自然滚动，直接滚动窗口到底部
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
}

function refresh(history) {
  chatEl.innerHTML = "";
  for (const m of history) chatEl.appendChild(renderMessage(m));
  if (!history.length) showWelcome();
  scrollBottom();
}

function showWelcome() {
  chatEl.appendChild(
    renderMessage({
      role: "assistant",
      content: null,
      html:
        "<p>你好！我是 <b>Lark 文档助手</b> 🤖</p>" +
        "<p>把 <b>飞书/Lark 文档链接</b> 和你的问题一起发给我，我会调用本地 Lark CLI 读取文档后回答，并支持多轮追问。</p>" +
        "<p>试试点击下方的示例文档，或粘贴：<code>https://demo.feishu.cn/docx/doccnABC123xyz</code></p>",
    })
  );
}

function setBusy(v) {
  busy = v;
  sendBtn.disabled = v;
  input.disabled = v;
}

async function post(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function handleSend(text) {
  setBusy(true);
  chatEl.appendChild(renderMessage({ role: "user", content: text }));
  const typing = el("div", "typing");
  typing.textContent = "Agent 处理中（提取链接 → 调用 Lark CLI → 生成回复）";
  chatEl.appendChild(typing);
  scrollBottom();

  try {
    await sendStreaming(text, typing);
  } catch (e) {
    typing.remove();
    chatEl.appendChild(renderMessage({ role: "assistant", content: `❌ 请求失败：${e.message}` }));
    scrollBottom();
  } finally {
    setBusy(false);
    input.focus();
  }
}

/**
 * 流式发送：POST /api/chat/stream，按行读 NDJSON 事件。
 * 事件契约定义见 src/protocol.js（start / tool / delta / done / error）。
 * 流式期间在气泡里累积 Markdown 原文（打字机效果），done 后整体替换为服务端渲染的完整卡片。
 */
async function sendStreaming(text, typing) {
  const resp = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message: text }),
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
  const onEvent = (evt) => {
    if (evt.type === "start") {
      sessionId = evt.sessionId;
      localStorage.setItem("lark-docs-session", sessionId);
    } else if (evt.type === "tool") {
      if (typing.parentNode) typing.remove();
      if (!toolsEl) {
        toolsEl = el("div", "toolcalls");
        wrap.insertBefore(toolsEl, bubble);
      }
      toolsEl.innerHTML = "";
      toolsEl.appendChild(toolChipsEl(evt.toolCalls || []));
      scrollBottom();
    } else if (evt.type === "delta") {
      if (typing.parentNode) typing.remove();
      bubble.textContent += evt.text;
      scrollBottom();
    } else if (evt.type === "done") {
      finished = true;
      if (typing.parentNode) typing.remove();
      wrap.replaceWith(renderMessage(evt.reply));
      refreshHealth();
      scrollBottom();
    } else if (evt.type === "error") {
      if (typing.parentNode) typing.remove();
      bubble.classList.remove("streaming");
      bubble.textContent += (bubble.textContent ? "\n\n" : "") + `❌ ${evt.error}`;
      errMsg = evt.error;
    }
  };

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
  if (!finished && !errMsg) throw new Error("流式连接提前结束");
}

function updateBadge(mode, model, agentMode) {
  if (agentMode === "pi") {
    badgeEl.className = "badge";
    badgeEl.textContent = "pi Agent 模式";
    return;
  }
  if (mode === "llm") {
    badgeEl.className = "badge";
    badgeEl.textContent = `LLM 模式${model ? ` · ${model}` : ""}`;
  } else {
    badgeEl.className = "badge sim";
    badgeEl.textContent = "模拟模式（未配置 LLM）";
  }
}

async function refreshHealth() {
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    updateBadge(health.mode, health.model, health.agentMode);
    if (health.agentMode === "pi" && health.piAvailable === false) {
      badgeEl.textContent = "pi Agent 模式（SDK 未安装，将降级）";
      badgeEl.className = "badge sim";
    }
  } catch {
    badgeEl.textContent = "服务未连接";
  }
}

// ---------- LLM 配置弹窗 ----------
function setLlmMsg(text, cls) {
  llmMsg.textContent = text;
  llmMsg.className = `modal-msg ${cls || ""}`;
}

async function openLlmModal() {
  try {
    const c = await fetch("/api/llm/config").then((r) => r.json());
    llmAgentMode.value = c.agentMode || "builtin";
    llmType.value = c.apiType || "chat";
    llmBase.value = c.baseUrl || "";
    llmModel.value = c.model || "";
    llmKey.value = "";
    llmKey.placeholder = c.hasKey ? `已配置（${c.keyMasked}），留空保持不变` : "sk-...";
  } catch {
    llmKey.placeholder = "sk-...";
  }
  setModelMode("input");
  setLlmMsg("");
  llmModal.classList.remove("hidden");
}

function closeLlmModal() {
  llmModal.classList.add("hidden");
}

function llmFormPayload() {
  const payload = { agentMode: llmAgentMode.value, apiType: llmType.value, baseUrl: llmBase.value.trim(), model: llmModel.value.trim() };
  const key = llmKey.value.trim();
  if (key) payload.apiKey = key; // 留空 = 保持已存 Key
  return payload;
}

llmBtn.addEventListener("click", openLlmModal);
document.getElementById("llm-cancel").addEventListener("click", closeLlmModal);
// 注意：点击遮罩区域不关闭弹窗，避免误触丢失已填写的配置；仅「取消」按钮或 Esc 关闭
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !llmModal.classList.contains("hidden")) closeLlmModal();
});

document.getElementById("llm-save").addEventListener("click", async () => {
  try {
    const data = await post("/api/llm/config", llmFormPayload());
    setLlmMsg(`✓ 已保存并生效（${data.config.apiType} · ${data.config.model}）`, "ok");
    refreshHealth();
    setTimeout(closeLlmModal, 600);
  } catch (e) {
    setLlmMsg(`保存失败：${e.message}`, "err");
  }
});

document.getElementById("llm-test").addEventListener("click", async () => {
  setLlmMsg("正在测试连接…");
  try {
    const r = await post("/api/llm/test", llmFormPayload());
    setLlmMsg(`✓ 连接成功（${r.apiType} · ${r.model}，${r.latencyMs}ms）：${r.sample}`, "ok");
  } catch (e) {
    setLlmMsg(`✗ 连接失败：${e.message}`, "err");
  }
});

document.getElementById("llm-reset").addEventListener("click", async () => {
  try {
    await post("/api/llm/config/reset", {});
    setLlmMsg("已恢复默认（未配置 LLM，回到模拟模式）", "ok");
    refreshHealth();
    llmKey.value = "";
    llmKey.placeholder = "sk-...";
    setModelMode("input");
  } catch (e) {
    setLlmMsg(`重置失败：${e.message}`, "err");
  }
});

// ---------- 模型字段：select 下拉 / 手动输入双模式 ----------
function setModelMode(mode) {
  if (mode === "select") {
    llmModel.classList.add("hidden");
    llmModelSelect.classList.remove("hidden");
    llmManualBtn.classList.remove("hidden");
  } else {
    llmModelSelect.classList.add("hidden");
    llmModel.classList.remove("hidden");
    llmManualBtn.classList.add("hidden");
  }
}

// select 与隐藏 input 始终保持同值，保存逻辑只读 input
function fillModelSelect(models) {
  const current = llmModel.value.trim();
  const options = current && !models.includes(current) ? [current, ...models] : models;
  llmModelSelect.innerHTML = "";
  for (const m of options) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    llmModelSelect.appendChild(opt);
  }
  if (current) llmModelSelect.value = current;
  setModelMode("select");
}

llmModelSelect.addEventListener("change", () => {
  llmModel.value = llmModelSelect.value;
});

llmManualBtn.addEventListener("click", () => {
  setModelMode("input");
  llmModel.focus();
});

llmFetchBtn.addEventListener("click", async () => {
  const base = llmBase.value.trim();
  if (!base) {
    setLlmMsg("请先填写 Base URL 再拉取模型列表", "err");
    llmBase.focus();
    return;
  }
  llmFetchBtn.disabled = true;
  llmFetchBtn.textContent = "拉取中…";
  try {
    const r = await post("/api/llm/models", llmFormPayload());
    const models = r.models || [];
    if (!models.length) {
      setLlmMsg("⚠️ 网关返回了空模型列表，可切换为手动输入", "err");
      return;
    }
    fillModelSelect(models);
    setLlmMsg(`✓ 已拉取 ${models.length} 个模型，请在下拉列表中选择（或切换手动输入）`, "ok");
  } catch (e) {
    setLlmMsg(`✗ 拉取模型列表失败：${e.message}`, "err");
  } finally {
    llmFetchBtn.disabled = false;
    llmFetchBtn.textContent = "↻ 拉取列表";
  }
});

// ---------- 事件 ----------
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
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
  if (sessionId) {
    try {
      await post("/api/session/clear", { sessionId });
    } catch { /* 忽略，本地重置即可 */ }
  }
  refresh([]);
});

// ---------- 初始化 ----------
(async function init() {
  await refreshHealth();

  try {
    const { items } = await fetch("/api/examples").then((r) => r.json());
    for (const d of items || []) {
      const chip = el("button", "example-chip");
      chip.type = "button";
      chip.textContent = `📄 ${d.title}`;
      chip.title = d.url;
      chip.addEventListener("click", () => {
        input.value = `帮我总结这篇文档：${d.url}`;
        input.focus();
        input.dispatchEvent(new Event("input"));
      });
      examplesEl.appendChild(chip);
    }
  } catch { /* 示例加载失败不影响主流程 */ }

  if (sessionId) {
    try {
      const { messages } = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.json());
      if (messages.length) {
        refresh(messages);
        return;
      }
    } catch { /* 落到欢迎页 */ }
  }
  showWelcome();
})();
