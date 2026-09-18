/**
 * lark CLI 透传执行（src/lark.js 的 runLarkCommand，供 pi agent 的通用 lark_cli 工具使用）：
 * - 不限制子命令、不解析输出：stdout/stderr/退出码原样返回（含非 JSON 输出）；
 * - 失败不重试、不降级其他命令——命令面适配交由 agent 自主探索；
 * - 与 runLarkCli 共用检测门：未检测到 CLI 时 code -2 友好提示，不执行任何命令；
 * - 超时/启动失败兜底为 ok:false，不让服务端抛异常。
 * 场景在独立子进程中执行（模块级探测缓存按进程隔离），不经 HTTP 服务。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const LARK_JS = path.join(__dirname, "..", "src", "lark.js");
const dirs = [];

/** 写一个可执行 node 脚本 CLI（记录每次被调用的参数，供断言执行次数） */
function writeCli(dir, body) {
  const p = path.join(dir, "lark-cli");
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** 两步检测（真实 lark-cli 登录形态）+ 记录调用 + 自定义命令处理体 */
const cliBody = (handlers) => `const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "invocations"), JSON.stringify(args) + "\\n");
if (args[0] === "--version") process.exit(0);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ appId: "cli_real", brand: "feishu", verified: true }));
  process.exit(0);
}
${handlers}
process.exit(1);`;

/** 在独立子进程中以 LARK_CLI=cli 运行 runLarkCommand(args, timeoutMs)，返回结果与夹具目录 */
function runScenario(cliBodyText, args, { timeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-cmd-"));
  dirs.push(dir);
  const cli = writeCli(dir, cliBodyText);
  const script =
    `const { runLarkCommand } = require(${JSON.stringify(LARK_JS)});` +
    `runLarkCommand(${JSON.stringify(args)}${timeoutMs ? `, ${JSON.stringify(timeoutMs)}` : ""})` +
    `.then((r) => process.stdout.write(JSON.stringify(r)))` +
    `.catch((e) => { console.error(e && e.message || e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, LARK_CLI: cli, LARK_PROBE_RETRY_MS: "0" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `场景执行失败：${r.stderr}`);
  return { result: JSON.parse(r.stdout), dir };
}

/** 读取夹具记录的调用参数列表 */
function invocations(dir) {
  const f = path.join(dir, "invocations");
  return fs.existsSync(f)
    ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

test("透传执行：任意子命令 + 非 JSON 输出原样返回，不做信封解析", () => {
  const { result } = runScenario(
    cliBody(`
if (args[0] === "docs" && args[1] === "fetch") {
  process.stdout.write("# 真实文档\\n正文段落");
  process.exit(0);
}`),
    ["docs", "fetch", "tok"]
  );
  assert.equal(result.ok, true);
  assert.equal(result.exit, 0);
  assert.equal(result.stdout, "# 真实文档\n正文段落");
  assert.equal(result.data, null);
});

test("失败透传：退出码与 stderr 原样保留，不重试、不降级其他命令", () => {
  const { result, dir } = runScenario(
    cliBody(`
if (args[0] === "doc" && args[1] === "get") {
  process.stderr.write("unknown command: doc get");
  process.exit(1);
}`),
    ["doc", "get", "tok"]
  );
  assert.equal(result.ok, false);
  assert.equal(result.exit, 1);
  assert.ok(result.stderr.includes("unknown command: doc get"));
  assert.ok(result.msg.includes("unknown command"));
  assert.equal(
    invocations(dir).filter((a) => a[0] === "doc").length,
    1,
    "doc 命令仅执行一次：失败后不重试、不自动换用其他命令"
  );
});

test("未检测到 CLI：code -2 友好提示，不执行任何命令", () => {
  const { result, dir } = runScenario("process.exit(3);", ["doc", "list"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, -2);
  assert.equal(result.exit, null);
  assert.equal(result.stdout, "");
  assert.ok(result.msg.includes("未检测到"));
  assert.deepEqual(invocations(dir), []);
});

test("超时：ok false 且标记 timedOut，不抛异常", () => {
  const { result } = runScenario(
    cliBody(`
if (args[0] === "docs" && args[1] === "fetch") {
  require("child_process").execSync("sleep 1");
  process.exit(0);
}`),
    ["docs", "fetch", "tok"],
    { timeoutMs: 100 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(result.msg.includes("超时"));
});

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
