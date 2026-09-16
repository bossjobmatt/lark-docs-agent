/** 跨模块共享的可变状态（单一来源，各模块经此读写） */
export const state = {
  sessionId: localStorage.getItem("lark-docs-session") || null,
  busy: false,
  lastHealth: null,
};
