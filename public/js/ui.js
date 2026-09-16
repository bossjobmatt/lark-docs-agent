/** DOM 构建与渲染辅助、消息卡片、Markdown 前端渲染（含流式增量切分）、自动滚动管理 */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

/** 工具调用徽标列表（流式与非流式渲染共用） */
export function toolChipsEl(toolCalls) {
  const tools = el("div", "toolcalls");
  for (const t of toolCalls) {
    const chip = el("span", `tool ${t.status || ""}`);
    const icon = t.status === "ok" ? "🛠" : t.status === "cache" ? "⚡" : t.status === "error" ? "❌" : "🛠";
    chip.textContent = `${icon} $ ${t.tool} ${t.args} — ${t.summary}`;
    tools.appendChild(chip);
  }
  return tools;
}

/** 单条消息卡片（历史恢复、流式 done 替换、欢迎页共用） */
export function renderMessage(m) {
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

// 前端流式渲染：vendored marked（public/vendor/，与 npm 依赖同版本）+ 与服务端一致的轻量消毒
function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function frontendMarkdown(md) {
  if (!window.marked) return null;
  try {
    return sanitizeHtml(window.marked.parse(String(md), { gfm: true, breaks: true }));
  } catch {
    return null;
  }
}

/**
 * 流式增量切分：返回 [稳定前缀, 活跃尾行]。
 * 前缀只含完整行，marked 永远见不到半截块开头（## / - / ``` 等），从根源上杜绝
 * 空标题、空列表项、空代码块等空白中间态；未完行交给调用方以纯文本尾随显示。
 * 围栏刚开启且尚无代码行时，把开启行退回尾行，避免渲染空代码块；
 * 代码块已有内容后未闭合围栏留在前缀内正常增长。
 */
export function streamingSplit(md) {
  const text = String(md);
  const nl = text.lastIndexOf("\n");
  if (nl < 0) return ["", text];
  let cut = nl + 1;
  const fenceIdx = () => [...text.slice(0, cut).matchAll(/^[ \t]*(?:```|~~~)/gm)].map((m) => m.index);
  const fences = fenceIdx();
  if (fences.length % 2 === 1) {
    const last = fences[fences.length - 1];
    const afterOpener = text.slice(last, cut).replace(/^[^\n]*\n/, "");
    if (!afterOpener.trim()) cut = last;
  }
  return [text.slice(0, cut), text.slice(cut)];
}

/** 流式帧渲染：稳定前缀走 marked，未完行以纯文本尾随（保持打字机观感） */
export function streamingMarkdown(md) {
  if (!window.marked) return null;
  const [prefix, tail] = streamingSplit(md);
  const prefixHtml = frontendMarkdown(prefix);
  const tailHtml = tail ? `<p class="stream-tail">${escapeHtml(tail)}</p>` : "";
  return (prefixHtml ?? escapeHtml(prefix)) + tailHtml;
}

// 自动滚动：仅在贴近底部时跟随；用户上翻即暂停，滚回底部自动恢复
let autoScroll = true;
function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 90;
}
window.addEventListener("scroll", () => (autoScroll = nearBottom()), { passive: true });

export function scrollBottom(force) {
  if (!force && !autoScroll) return;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: force ? "smooth" : "auto" });
}
