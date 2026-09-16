/**
 * HTTP 层端到端测试：spawn mock 网关 + 服务（全部指向临时文件与随机端口），
 * 验证流式事件序列、会话列表与删除、/api/chat 瘦身响应。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const MOCK_PORT = 9191;
const APP_PORT = 9292;
const SESSIONS_FILE = `/tmp/lark-test-e2e-${process.pid}.json`;
const LLM_CONFIG_FILE = `/tmp/lark-test-e2e-llm-${process.pid}.json`;

let mockProc = null;
let appProc = null;

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: APP_PORT, ...opts }, (res) => {
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

test.before(async () => {
  fs.rmSync(SESSIONS_FILE, { force: true });
  // 为 pi 模式自建 agentDir，provider 指向本次 mock 网关
  const piDir = `/tmp/lark-test-pidir-${process.pid}`;
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(
    path.join(piDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          name: "mock",
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
          apiKey: "sk-mock",
          authHeader: true,
          models: [{ id: "mock-model", name: "mock-model" }],
        },
      },
    })
  );
  fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model" }));
  mockProc = spawn("node", [path.join(ROOT, "fixtures/mock-openai.js")], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  });
  appProc = spawn("node", [path.join(ROOT, "src/server.js")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      SESSIONS_FILE,
      LLM_CONFIG_FILE,
      AGENT_MODE: "pi",
      PI_AGENT_DIR: piDir,
      LLM_API_KEY: "sk-mock",
      LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      LLM_MODEL: "mock-model",
      // 内置 mock 不再默认生效：e2e 显式指定其作为演示 CLI
      LARK_CLI: path.join(ROOT, "bin", "lark"),
    },
  });
  await waitPort(APP_PORT);
});

test.after(() => {
  mockProc && mockProc.kill();
  appProc && appProc.kill();
  fs.rmSync(SESSIONS_FILE, { force: true });
  fs.rmSync(LLM_CONFIG_FILE, { force: true });
});

test("流式接口：start → tool → delta×n → done（mode=pi，工具被调用）", async () => {
  const res = await request(
    { method: "POST", path: "/api/chat/stream", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ message: "总结这份文档 https://demo.feishu.cn/docx/doccnABC123xyz 的里程碑" })
  );
  assert.equal(res.status, 200);
  const events = res.text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(events[0].type, "start");
  assert.ok(events.some((e) => e.type === "tool"), "应有工具快照");
  const deltas = events.filter((e) => e.type === "delta");
  assert.ok(deltas.length >= 3, "应有正文增量");
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.reply.mode, "pi");
  assert.ok(done.reply.html.length > 0);
  assert.equal(done.reply.toolCalls.length, 1);
});

test("/api/chat 响应已瘦身（无 history 字段）", async () => {
  const res = await request(
    { method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ message: "你好" })
  );
  const data = JSON.parse(res.text);
  assert.equal(res.status, 200);
  assert.ok(!("history" in data), "history 已从响应移除");
  assert.ok(data.message.role === "assistant");
});

test("会话列表与删除：/api/sessions + /api/session/delete", async () => {
  let res = await request({ path: "/api/sessions" });
  const list = JSON.parse(res.text).sessions;
  assert.ok(list.length >= 2, "前面两轮对话应产生至少 2 个会话");
  assert.ok(list[0].title.length > 0 && list[0].messageCount > 0);

  const target = list[list.length - 1].id;
  res = await request(
    { method: "POST", path: "/api/session/delete", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ sessionId: target })
  );
  assert.equal(JSON.parse(res.text).ok, true);

  res = await request({ path: "/api/sessions" });
  assert.ok(!JSON.parse(res.text).sessions.some((s) => s.id === target), "删除后列表不再包含该会话");
});
