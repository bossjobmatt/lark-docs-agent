/**
 * 图片链路测试：normalizeImages 校验、落盘剥离 images、e2e 多模态组装与非法输入 400。
 * 独立进程：顶部先注入环境变量再 require 模块（IMAGE_MAX_KB=1 便于构造超限用例）。
 */
process.env.IMAGE_MAX_KB = "1"; // 1KB 上限，便于测试超限
process.env.SESSIONS_FILE = `/tmp/lark-test-img-sessions-${process.pid}.json`;

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const { normalizeImages, bodyLimit } = require("../src/images");
const store = require("../src/store");

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MOCK_PORT = 9593; // 注意：node --test 多文件并行，端口不能与其他测试文件冲突（9191/9292/9393/9494+ 已占用）
const APP_PORT = 9594;
const APP_SESSIONS_FILE = `/tmp/lark-test-img-e2e-${process.pid}.json`;
const APP_LLM_CONFIG_FILE = `/tmp/lark-test-img-llm-${process.pid}.json`;

let mockProc = null;
let appProc = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitPort(port, tries = 30) {
  return new Promise((resolve, reject) => {
    const probe = (n) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => (n > 0 ? setTimeout(() => probe(n - 1), 200) : reject(new Error("port not ready"))));
    };
    probe(tries);
  });
}

// ---------- normalizeImages 单元测试 ----------

test("normalizeImages：合法图片归一化为 { mime, data, name? }", () => {
  const out = normalizeImages([{ mime: "image/png", data: ` ${PNG_1PX} `, name: "截图.png" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].mime, "image/png");
  assert.equal(out[0].data, PNG_1PX); // 空白被剥离
  assert.equal(out[0].name, "截图.png");
});

test("normalizeImages：undefined/null 回落空数组（无图片消息兼容）", () => {
  assert.deepEqual(normalizeImages(undefined), []);
  assert.deepEqual(normalizeImages(null), []);
});

test("normalizeImages：非法输入逐一拒绝", () => {
  assert.throws(() => normalizeImages("not-array"), /数组/);
  assert.throws(() => normalizeImages([{ mime: "image/gif", data: PNG_1PX }]), /格式不支持/);
  assert.throws(() => normalizeImages([{ mime: "image/png", data: "" }]), /为空/);
  assert.throws(() => normalizeImages([{ mime: "image/png", data: "!!!not-base64!!!" }]), /数据非法/);
  assert.throws(() => normalizeImages([{ mime: "image/png", data: "A".repeat(2000) }]), /超过 1KB/); // 解码后 1500 字节
  assert.throws(
    () => normalizeImages([{ mime: "image/png", data: PNG_1PX }, { mime: "image/png", data: PNG_1PX }, { mime: "image/png", data: PNG_1PX }, { mime: "image/png", data: PNG_1PX }]),
    /最多 3 张/
  );
});

test("bodyLimit：随 IMAGE_MAX_KB 与图片数量上限缩放，且容得下满额图片", () => {
  assert.ok(bodyLimit() > 3 * 1024 * 2); // 3 张 × 1KB × base64 膨胀 + 余量
});

// ---------- store 落盘剥离 ----------

test("落盘剥离 images：文件无该字段，内存中保留（刷新后不回显图片）", async () => {
  const s = store.getOrCreate();
  store.appendMessages(s.id, [
    { role: "user", content: "看看这张图", images: [{ mime: "image/png", data: PNG_1PX, name: "a.png" }], ts: "t1" },
  ]);
  await sleep(450); // persist 防抖 300ms
  const raw = JSON.parse(fs.readFileSync(process.env.SESSIONS_FILE, "utf8"));
  const saved = raw.find((x) => x.id === s.id);
  assert.ok(saved.messages.length === 1);
  assert.ok(!("images" in saved.messages[0]), "落盘不应包含 images");
  assert.equal(saved.messages[0].content, "看看这张图");
  assert.equal(store.get(s.id).messages[0].images.length, 1, "内存中 images 保留");
});

// ---------- e2e：spawn mock 网关 + 服务（builtin 模式，验证多模态组装与校验 400） ----------

test.before(async () => {
  fs.rmSync(APP_SESSIONS_FILE, { force: true });
  const errLog = fs.openSync(`/tmp/lark-test-img-app-err-${process.pid}.log`, "a");
  mockProc = spawn("node", [path.join(ROOT, "fixtures/mock-openai.js")], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  });
  appProc = spawn("node", [path.join(ROOT, "src/server.js")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      SESSIONS_FILE: APP_SESSIONS_FILE,
      LLM_CONFIG_FILE: APP_LLM_CONFIG_FILE,
      AGENT_MODE: "builtin",
      LLM_API_TYPE: "chat",
      LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      LLM_API_KEY: "sk-mock",
      LLM_MODEL: "mock-model",
      LARK_CLI: path.join(ROOT, "fixtures", "lark-demo", "lark"),
      IMAGE_MAX_KB: "1",
    },
    stdio: ["ignore", "ignore", errLog],
  });
  await waitPort(APP_PORT);
});

test.after(() => {
  mockProc && mockProc.kill();
  appProc && appProc.kill();
  fs.rmSync(APP_SESSIONS_FILE, { force: true });
  fs.rmSync(APP_LLM_CONFIG_FILE, { force: true });
});

/** 取 mock 捕获的请求体中「含多模态 content 的最近一次」（标题生成等后台请求不含图片，需筛选） */
async function fetchMultimodalBody() {
  const last = await request(MOCK_PORT, { path: "/v1/debug/last-body", headers: { Authorization: "Bearer sk-mock" } });
  const { bodies } = JSON.parse(last.text);
  return [...bodies].reverse().find((b) => (b.messages || []).some((m) => Array.isArray(m.content)));
}

test("e2e：/api/chat 带 images → LLM 收到 OpenAI 多模态 content（image_url + text）", async () => {
  const res = await request(
    APP_PORT,
    { method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ message: "看看这张图", images: [{ mime: "image/png", data: PNG_1PX, name: "a.png" }] })
  );
  assert.equal(res.status, 200);
  const data = JSON.parse(res.text);
  assert.ok(data.message.content.length > 0);

  const body = await fetchMultimodalBody();
  assert.ok(body, "mock 应捕获到多模态请求");
  const lastUser = (body.messages || []).filter((m) => m.role === "user").pop();
  assert.ok(Array.isArray(lastUser.content), "当前消息应升级为多模态 content 数组");
  const imgPart = lastUser.content.find((c) => c.type === "image_url");
  assert.ok(imgPart, "应包含 image_url 块");
  assert.ok(imgPart.image_url.url.startsWith(`data:image/png;base64,${PNG_1PX}`));
  const textPart = lastUser.content.find((c) => c.type === "text");
  assert.equal(textPart.text, "看看这张图");
  const historyUsers = (body.messages || []).filter((m) => m.role === "user").slice(0, -1);
  assert.ok(historyUsers.every((m) => typeof m.content === "string"), "历史消息保持纯文本（图片不重发）");
});

test("e2e：/api/chat/stream 带 images → 事件序列 start → delta×n → done 不受影响", async () => {
  const res = await request(
    APP_PORT,
    { method: "POST", path: "/api/chat/stream", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ message: "描述图片", images: [{ mime: "image/jpeg", data: PNG_1PX }] })
  );
  assert.equal(res.status, 200);
  const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events[0].type, "start");
  assert.ok(events.filter((e) => e.type === "delta").length >= 1);
  assert.equal(events.at(-1).type, "done");
});

test("e2e：纯图片消息（无文本）可发送，图片引导文本进 LLM，历史留「（图片）」占位", async () => {
  const res = await request(
    APP_PORT,
    { method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ images: [{ mime: "image/png", data: PNG_1PX }] })
  );
  assert.equal(res.status, 200);
  const { sessionId } = JSON.parse(res.text);
  const body = await fetchMultimodalBody();
  const lastUser = (body.messages || []).filter((m) => m.role === "user").pop();
  assert.equal(lastUser.content.find((c) => c.type === "text").text, "请分析这些图片");

  const history = await request(APP_PORT, { path: `/api/history?sessionId=${encodeURIComponent(sessionId)}` });
  const stored = JSON.parse(history.text).messages.find((m) => m.role === "user");
  assert.equal(stored.content, "（图片）", "纯图片消息应落「（图片）」占位，历史与标题生成有依据");
});

test("e2e：非法图片与空消息 → 400，错误信息面向用户", async () => {
  const post = (bodyObj) =>
    request(APP_PORT, { method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json" } }, JSON.stringify(bodyObj));

  let res = await post({ message: "hi", images: [{ mime: "image/gif", data: PNG_1PX }] });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error, /格式不支持/);

  res = await post({ message: "hi", images: [{ mime: "image/png", data: "A".repeat(2000) }] });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error, /超过 1KB/);

  res = await post({ message: "hi", images: "oops" });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error, /数组/);

  res = await post({ message: "" });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error, /至少其一/);
});
