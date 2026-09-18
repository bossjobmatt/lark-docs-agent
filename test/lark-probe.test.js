/**
 * lark CLI 两步检测行为（src/lark.js 的 probeResolve）：
 * - 第一步·安装检测：直接执行 `--version`，退出码 0 即已安装（不扫描常见安装位置）；
 * - 第二步·登录检测：直接执行 `auth status --json --verify`，stdout JSON 满足
 *   ok === true && verified === true 才算已登录——信封 { code: 0 } 或 verified:false 均不可用；
 * - LARK_CLI 显式指定同样须通过两步检测，失败不静默当作可用；
 * - 探测失败按 LARK_PROBE_RETRY_MS 短期缓存，装好 CLI 后无需重启即可自愈；
 * - PATH 探测不落 CWD：同名 lark-cli 脚本不被误执行。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lark-probe-"));
const PATH_DIR = path.join(TMP, "bin"); // 「安装目录」用例的 PATH 成员

let nextPort = 9494;

/** 起一个封闭环境的服务（PATH 不含 lark-cli、不设 LARK_CLI），envOverrides 覆盖默认注入 */
function startApp(envOverrides = {}, spawnOpts = {}) {
  const port = nextPort++;
  const proc = spawn("node", [path.join(ROOT, "src/server.js")], {
    cwd: spawnOpts.cwd,
    env: {
      ...process.env,
      PORT: String(port),
      SESSIONS_FILE: path.join(TMP, `sessions-${port}.json`),
      LLM_CONFIG_FILE: path.join(TMP, `llm-${port}.json`),
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LARK_CLI: "", // 封闭环境：不显式指定 CLI
      ...envOverrides,
    },
  });
  return { proc, port };
}

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

function waitPort(port, tries = 50) {
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

/** 写一个可执行 node 脚本，返回其路径（默认名 lark-cli，与 PATH 直查目标同名） */
function writeCli(dir, body, name = "lark-cli") {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** 两步检测的标准夹具 CLI：--version 退出码 0；auth status --json --verify 输出指定登录状态 */
const detectCliBody = (loggedIn) => `const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ ok: ${loggedIn}, verified: ${loggedIn} }));
  process.exit(0);
}
process.exit(1);`;

async function getLark(port) {
  const res = await request(port, { path: "/api/health" });
  return JSON.parse(res.text).lark;
}

test("LARK_CLI 指向不存在路径：不可用且 source=env，而非假报可用", async () => {
  const { proc, port } = startApp({ LARK_CLI: path.join(TMP, "no-such-cli") });
  try {
    await waitPort(port);
    const lark = await getLark(port);
    assert.equal(lark.available, false);
    assert.equal(lark.source, "env");
    assert.ok(/LARK_CLI/.test(lark.reason), "reason 应指明 LARK_CLI 验证失败");
  } finally {
    proc.kill();
  }
});

test("两步判据：--version 与 auth status（ok+verified）均通过才可用", async () => {
  const cli = writeCli(path.join(TMP, "alt"), detectCliBody(true));
  const { proc, port } = startApp({ LARK_CLI: cli });
  try {
    await waitPort(port);
    const lark = await getLark(port);
    assert.equal(lark.available, true);
    assert.equal(lark.source, "env");
    assert.equal(lark.path, cli);
  } finally {
    proc.kill();
  }
});

test("已安装但未登录/未验证：不可用，reason 指明登录检测", async () => {
  const cli = writeCli(path.join(TMP, "unverified"), detectCliBody(false));
  const { proc, port } = startApp({ LARK_CLI: cli });
  try {
    await waitPort(port);
    const lark = await getLark(port);
    assert.equal(lark.available, false);
    assert.ok(/登录检测/.test(lark.reason), "reason 应指明 auth status 登录检测未通过");
  } finally {
    proc.kill();
  }
});

test("登录判据回归：信封 code 0 不再视为已登录", async () => {
  const body = `const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ code: 0, msg: "success", data: { status: "ok" } }));
  process.exit(0);
}
process.exit(1);`;
  const cli = writeCli(path.join(TMP, "legacy-envelope"), body);
  const { proc, port } = startApp({ LARK_CLI: cli });
  try {
    await waitPort(port);
    const lark = await getLark(port);
    assert.equal(lark.available, false, "仅满足旧信封契约的 CLI 不应被判为可用");
    assert.ok(/登录检测/.test(lark.reason));
  } finally {
    proc.kill();
  }
});

test("探测失败短 TTL 缓存：装好 CLI 后无需重启即可检测到", async () => {
  const { proc, port } = startApp({
    LARK_PROBE_RETRY_MS: "300",
    PATH: `${PATH_DIR}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  });
  try {
    await waitPort(port);
    assert.equal((await getLark(port)).available, false);
    writeCli(PATH_DIR, detectCliBody(true));
    await new Promise((r) => setTimeout(r, 500)); // > LARK_PROBE_RETRY_MS，失败缓存过期
    const lark = await getLark(port);
    assert.equal(lark.available, true);
    assert.equal(lark.source, "path");
  } finally {
    proc.kill();
  }
});

test("PATH 探测不落 CWD：同名 lark-cli 脚本不被误执行", async () => {
  const trapDir = path.join(TMP, "trap");
  writeCli(trapDir, 'require("fs").writeFileSync(require("path").join(__dirname, "marker"), "run");');
  const { proc, port } = startApp({}, { cwd: trapDir });
  try {
    await waitPort(port);
    const lark = await getLark(port);
    assert.equal(lark.available, false);
    assert.equal(lark.source, "none");
    assert.ok(!fs.existsSync(path.join(trapDir, "marker")), "CWD 下的同名 lark-cli 脚本不应被误执行");
  } finally {
    proc.kill();
  }
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
