/**
 * 未检测到 lark CLI 时的行为：不执行任何命令，返回友好提示。
 * PATH 指向不含 lark 的目录，保证探测结果确定。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const APP_PORT = 9393;
const SESSIONS_FILE = `/tmp/lark-test-nocli-${process.pid}.json`;
const LLM_CONFIG_FILE = `/tmp/lark-test-nocli-llm-${process.pid}.json`;

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
  appProc = spawn("node", [path.join(ROOT, "src/server.js")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      SESSIONS_FILE,
      LLM_CONFIG_FILE,
      // PATH 仅含 node 所在目录与系统目录：node 可用，但不含 lark，探测必然失败
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      // 不设 LARK_CLI：模拟全新环境
    },
  });
  await waitPort(APP_PORT);
});

test.after(() => {
  appProc && appProc.kill();
  fs.rmSync(SESSIONS_FILE, { force: true });
  fs.rmSync(LLM_CONFIG_FILE, { force: true });
});

test("health 报告 lark 不可用", async () => {
  const res = await request({ path: "/api/health" });
  const health = JSON.parse(res.text);
  assert.equal(health.lark.available, false);
  assert.equal(health.lark.source, "none");
});

test("带文档链接提问：不执行命令，回复包含安装认证提示", async () => {
  const res = await request(
    { method: "POST", path: "/api/chat", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ message: "帮我总结 https://demo.feishu.cn/docx/doccnABC123xyz" })
  );
  const data = JSON.parse(res.text);
  assert.equal(res.status, 200);
  const chip = data.message.toolCalls && data.message.toolCalls[0];
  assert.ok(chip, "应有工具徽标");
  assert.ok(/未检测到/.test(chip.summary), "提示应说明需要本地 lark CLI");
  assert.ok(/LARK_CLI/.test(chip.summary), "提示应包含配置方式");
});

test("examples 接口在不存 CLI 时返回空列表而非报错", async () => {
  const res = await request({ path: "/api/examples" });
  const data = JSON.parse(res.text);
  assert.deepEqual(data.items, []);
});
