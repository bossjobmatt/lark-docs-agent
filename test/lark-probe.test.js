/**
 * lark CLI 探测行为（src/lark.js 的 resolveCli）：
 * - LARK_CLI 显式指定同样须通过 auth status 认证检查，失败不静默当作可用；
 * - 信封 code 0 即可用，不要求 data.status 字段（回归信封契约，不耦合演示 mock 返回形状）；
 * - 探测失败按 LARK_PROBE_RETRY_MS 短期缓存，装好 CLI 后无需重启即可自愈；
 * - PATH 探测的 node 脚本兜底仅对路径形态生效，不误执行 CWD 下同名文件。
 * 所有用例显式 LARK_PATH_FALLBACKS=""，与宿主机是否装有 lark 无关。
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

/** 起一个封闭环境的服务（无 lark、兜底禁用），envOverrides 覆盖默认注入 */
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
      LARK_PATH_FALLBACKS: "", // 封闭环境：禁用常见位置兜底
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

/** 写一个对任何命令都输出指定信封的可执行 node 脚本，返回其路径 */
function writeCli(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "lark");
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

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

test("信封 code 0 即可用：不要求 data.status 字段（契约判据）", async () => {
  const cli = writeCli(
    path.join(TMP, "alt"),
    'process.stdout.write(JSON.stringify({ code: 0, msg: "success", data: { foo: "bar" } }));'
  );
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

test("探测失败短 TTL 缓存：装好 CLI 后无需重启即可检测到", async () => {
  const { proc, port } = startApp({
    LARK_PROBE_RETRY_MS: "300",
    PATH: `${PATH_DIR}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  });
  try {
    await waitPort(port);
    assert.equal((await getLark(port)).available, false);
    writeCli(PATH_DIR, 'process.stdout.write(JSON.stringify({ code: 0, msg: "success", data: { status: "ok" } }));');
    await new Promise((r) => setTimeout(r, 500)); // > LARK_PROBE_RETRY_MS，失败缓存过期
    const lark = await getLark(port);
    assert.equal(lark.available, true);
    assert.equal(lark.source, "path");
  } finally {
    proc.kill();
  }
});

test("PATH 探测不落 CWD：同名 lark 脚本不被误执行", async () => {
  const trapDir = path.join(TMP, "trap");
  writeCli(trapDir, 'require("fs").writeFileSync(require("path").join(__dirname, "marker"), "run");');
  const { proc, port } = startApp({}, { cwd: trapDir });
  try {
    await waitPort(port);
    const lark = await getLark(port);
    assert.equal(lark.available, false);
    assert.equal(lark.source, "none");
    assert.ok(!fs.existsSync(path.join(trapDir, "marker")), "CWD 下的同名 lark 脚本不应被误执行");
  } finally {
    proc.kill();
  }
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
