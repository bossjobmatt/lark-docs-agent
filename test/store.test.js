/**
 * store.js 行为测试（进程内，单实例）。
 * 落盘路径指向临时文件，避免污染真实 data/。
 */
process.env.SESSIONS_FILE = process.env.SESSIONS_FILE || "/tmp/lark-test-store.json";
require("fs").rmSync(process.env.SESSIONS_FILE, { force: true });

const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/store");

test("appendMessages 追加并触活，超过上限后裁剪保留最近消息", () => {
  const s = store.getOrCreate("");
  const filler = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `m${i}`,
  }));
  store.appendMessages(s.id, filler);
  const session = store.get(s.id);
  assert.equal(session.messages.length, 50); // SESSION_MAX_MESSAGES 默认 50
  assert.equal(session.messages.at(-1).content, "m59");
  assert.ok(session.updatedAt);
});

test("cacheDoc 上限 20 篇，超限淘汰最早缓存；dropOldestDoc 删除最早一篇", () => {
  const s = store.getOrCreate("");
  for (let i = 0; i < 21; i++) store.cacheDoc(s.id, `doccn${String(i).padStart(4, "0")}`, { title: `t${i}` });
  let session = store.get(s.id);
  assert.equal(Object.keys(session.docs).length, 20);
  assert.equal(session.docs.doccn0000, undefined); // 最早被淘汰
  store.cacheDoc(s.id, "doccnZZZZ", { title: "zz" });
  store.dropOldestDoc(s.id);
  session = store.get(s.id);
  assert.equal(session.docs.doccn0001, undefined);
  assert.equal(session.docs.doccnZZZZ.title, "zz");
});

test("listSessions 按最近活跃倒序，标题取首条用户消息", () => {
  const a = store.getOrCreate("");
  store.appendMessages(a.id, [{ role: "user", content: "第一句话是什么" }]);
  const b = store.getOrCreate("");
  b.updatedAt = new Date(Date.now() + 5000).toISOString(); // 人为更新
  const list = store.listSessions();
  assert.equal(list[0].id, b.id); // 最近活跃在前
  const item = list.find((x) => x.id === a.id);
  assert.equal(item.title, "第一句话是什么");
  assert.ok(item.messageCount >= 1);
});

test("clear 清空消息与文档缓存；remove 删除整个会话", () => {
  const s = store.getOrCreate("");
  store.appendMessages(s.id, [{ role: "user", content: "hi" }]);
  store.cacheDoc(s.id, "doccnAAAA", { title: "t" });
  store.clear(s.id);
  let session = store.get(s.id);
  assert.equal(session.messages.length, 0);
  assert.deepEqual(session.docs, {});
  store.remove(s.id);
  assert.equal(store.get(s.id), null);
});

test("落盘为紧凑 JSON，仅存 Markdown 原文（无 html/docs 字段）", async () => {
  const file = process.env.SESSIONS_FILE;
  const s = store.getOrCreate("");
  store.appendMessages(s.id, [
    { role: "user", content: "q" },
    { role: "assistant", content: "**a**", html: "<p><b>a</b></p>" },
  ]);
  await new Promise((r) => setTimeout(r, 400)); // 等防抖落盘
  const raw = require("fs").readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  const mine = data.find((p) => p.id === s.id);
  assert.ok(!raw.includes("\n  "), "应无缩进（紧凑存储）");
  assert.ok(mine.messages.every((m) => !("html" in m)), "html 不落盘");
  assert.ok(!("docs" in mine), "docs 不落盘");
});
