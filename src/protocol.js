/**
 * 流式事件与回复对象的唯一词汇表。
 * agent.js / pi-agent.js 生产事件，server.js 以 NDJSON 转发，public/app.js 消费——
 * 四处共享这里定义的契约；新增事件类型只改这一个文件（前端为文档化消费者）。
 *
 * 事件行（NDJSON，每行一个 JSON 对象）：
 *   { type: "start", sessionId }          连接建立，客户端由此获得 sessionId
 *   { type: "tool",  toolCalls: [...] }   工具调用快照（累积列表，status: ok|cache|error）
 *   { type: "delta", text }               正文增量（逐段追加）
 *   { type: "done",  sessionId, reply }   结束：携带完整回复（含渲染 HTML）
 *   { type: "error", error }              失败（流中途或整体失败）
 */
const { renderMarkdown } = require("./markdown");

/** 消息时间戳格式（历史消息与实时回复统一用这一份） */
function nowTs() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

/** 组装一条 assistant 回复对象（内置编排与 pi 模式共用） */
function makeReply(content, { mode, toolCalls = [] } = {}) {
  return {
    role: "assistant",
    content,
    html: renderMarkdown(content),
    toolCalls,
    mode,
    ts: nowTs(),
  };
}

const startEvent = (sessionId) => ({ type: "start", sessionId });
const toolEvent = (toolCalls) => ({ type: "tool", toolCalls });
const deltaEvent = (text) => ({ type: "delta", text });
const doneEvent = (sessionId, reply) => ({ type: "done", sessionId, reply });
const errorEvent = (message) => ({ type: "error", error: message });

/** 工具徽标快照发射器：绑定事件回调与累积 toolCalls 列表，agent 与 pi 两侧共用 */
function toolEmitter(onEvent, toolCalls) {
  return () => onEvent && onEvent(toolEvent([...toolCalls]));
}

module.exports = { makeReply, nowTs, startEvent, toolEvent, deltaEvent, doneEvent, errorEvent, toolEmitter };
