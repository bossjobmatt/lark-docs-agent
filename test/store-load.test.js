/**
 * store.js 加载路径测试：TTL 淘汰、消息截断、html 现算、docs 丢弃。
 * node --test 每个测试文件独立进程，因此可以安全地在 require 前注入环境变量。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const day = 24 * 3600 * 1000;
const now = Date.now();

const FILE = path.join(os.tmpdir(), `lark-test-load-${process.pid}.json`);
process.env.SESSIONS_FILE = FILE;
process.env.SESSION_TTL_DAYS = "1";
process.env.SESSION_MAX_MESSAGES = "3";
fs.writeFileSync(
  FILE,
  JSON.stringify([
    // 过期会话（2 天前不活跃）：应被 TTL 淘汰
    { id: "old", createdAt: new Date(now - 2 * day).toISOString(), messages: [{ role: "user", content: "旧问题" }] },
    // 活跃会话：10 条消息、assistant 无 html（应现算）、带 docs 字段（应丢弃）
    {
      id: "live",
      createdAt: new Date(now - 3600e3).toISOString(),
      updatedAt: new Date(now).toISOString(),
      messages: Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: i % 2 ? `**答${i}**` : `问${i}`,
      })),
      docs: { doccnX: { title: "t", content: "x".repeat(9999) } },
    },
  ])
);

const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/store");

test("启动时 TTL 淘汰过期会话", () => {
  assert.equal(store.get("old"), null);
});

test("活跃会话加载后：消息截断到上限、html 按原文现算、docs 字段丢弃", () => {
  const s = store.get("live");
  assert.ok(s, "活跃会话应保留");
  assert.equal(s.messages.length, 3, "加载时截断到 SESSION_MAX_MESSAGES=3");
  assert.equal(s.messages.at(-1).content, "**答9**", "保留的是最近的消息");
  const assistants = s.messages.filter((m) => m.role === "assistant");
  assert.ok(assistants.length > 0, "截断后仍应包含 assistant 消息");
  assert.ok(
    assistants.every((m) => typeof m.html === "string" && m.html.includes("<strong>答")),
    "assistant html 应由 Markdown 原文现算补齐"
  );
  assert.deepEqual(s.docs, {}, "docs 缓存不落盘，加载后为空");
});
