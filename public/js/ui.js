/** DOM 构建与渲染辅助、Markdown 前端渲染、自动滚动管理 */

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
