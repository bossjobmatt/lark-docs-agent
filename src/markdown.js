const { marked } = require("marked");

marked.setOptions({ gfm: true, breaks: true });

// 本地演示用的轻量消毒：去掉脚本类标签与内联事件属性
function sanitize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function renderMarkdown(md) {
  return sanitize(marked.parse(String(md)));
}

module.exports = { renderMarkdown };
