const { spawn } = require("child_process");
const fs = require("fs");

/**
 * lark CLI 的纯调用方约定，检测拆成两步、全部直接执行命令判定（不扫描安装位置）：
 * - 第一步·安装检测：执行 `<cli> --version`，退出码 0 即已安装；
 * - 第二步·登录检测：执行 `<cli> auth status --json --verify`，按 verified 证据判登录
 *   （兼容真实 lark-cli 顶层 { appId, brand, identities, ... } 无 ok 字段的输出，见下）。
 * CLI 的确定：LARK_CLI 环境变量显式指定（真实或演示 mock fixtures/lark-demo/lark）优先，
 * 否则直接执行 PATH 中的 `lark-cli`；都没有 → 不回落任何内置实现，
 * 工具调用返回友好提示，由用户自行安装并登录。
 * 探测结果缓存：成功永久；失败按 LARK_PROBE_RETRY_MS（默认 30s，显式 0 = 每次重探）
 * 短期缓存后自动重试——启动后才安装/登录 CLI 无需重启即可被检测到。
 * 执行面不做子命令限制、不做命令面适配，只提供两种透传程度的执行：
 * - runLarkCli：信封解析 { code, msg, data }（code 0 成功），供确定性路径（内置编排/示例列表）；
 * - runLarkCommand：原始透传（stdout/stderr/退出码原样返回），供 pi agent 的通用 lark_cli 工具
 *   自行探索真实命令面（如 --help、docs fetch）并解读输出。
 * 本项目只调用 CLI，不做其安装与凭据配置。
 */
const PROBE_TIMEOUT_MS = 4000;
const PROBE_RETRY_DEFAULT_MS = 30000;
const DEFAULT_COMMAND = "lark-cli";
// 抑制真实 lark-cli 的更新/技能提示，避免非 JSON 内容混入 stdout 干扰登录判据解析
const LOGIN_ENV = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };

let resolved = null; // { available: true, source, path } —— 成功结果永久缓存
let failed = null; // { result, expiresAt } —— 失败结果短 TTL 缓存，到期重探
let inflight = null; // 并发首次探测去重

/** 提取 stdout 中的首个 JSON 对象；整体解析失败时容忍非 JSON 前缀（如自更新提示），从首个 { 截取重试 */
function parseJsonOutput(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  if (start > 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch {}
  }
  return null;
}

/** 读取文件首行，判断是否 node 脚本（无执行位的 JS CLI 需经 node 启动） */
function isNodeScript(cliPath) {
  try {
    const head = fs.readFileSync(cliPath, "utf8").slice(0, 64);
    return head.startsWith("#!") && head.includes("node");
  } catch {
    return false;
  }
}

/**
 * 底层执行：spawn 收集退出码与原始输出，不做任何输出解析。
 * 无执行位/非可执行格式的 node 脚本：回退经 node 启动（内置演示 mock 即此形态）。
 * 仅对路径形态的 cliPath 启用——裸名（如 "lark-cli"）由 execvp 按 PATH 解析，
 * 若再按 CWD 相对读取同名文件，会误执行工作目录下的脚本。
 */
function spawnRaw(cliPath, args, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = spawn(cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exit: -1, stdout, stderr, timedOut: true, error: false });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const onClose = (code) => finish({ exit: code, stdout, stderr, timedOut: false, error: false });
    child.on("close", onClose);
    child.on("error", (e) => {
      child.removeAllListeners("close"); // 避免 error 后 close 双触发抢先用空输出结算
      if (cliPath.includes("/") && isNodeScript(cliPath)) {
        child = spawn(process.execPath, [cliPath, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...extraEnv },
        });
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", onClose);
        child.on("error", (e2) => finish({ exit: -1, stdout, stderr: `lark CLI 启动失败: ${e2.message}`, timedOut: false, error: true }));
      } else {
        finish({ exit: -1, stdout, stderr: `lark CLI 启动失败: ${e.message}`, timedOut: false, error: true });
      }
    });
  });
}

/** ① 安装检测：直接执行 `<cli> --version`，退出码 0 即已安装 */
async function isLarkCliInstalled(cliPath) {
  const r = await spawnRaw(cliPath, ["--version"], {}, PROBE_TIMEOUT_MS);
  return r.exit === 0;
}

/**
 * 登录判据（verified 证据制，兼容真实 lark-cli 的输出形态）：
 * - 上游约定形态：顶层 { ok, verified }，两者均为 true；
 * - 真实输出形态：顶层 { appId, brand, identities, ... }，可能没有 ok 字段——
 *   顶层 verified === true，或 identities（数组/对象均可）中存在 verified === true 的身份即可；
 * - 显式否定（顶层 ok === false 或 verified === false）一票否决；
 * - 信封 { code: 0 } 等无任何 verified 证据的输出不算已登录。
 */
function identitiesVerified(identities) {
  if (!identities) return false;
  const entries = Array.isArray(identities) ? identities : Object.values(identities);
  let any = false;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.verified === false) return false;
    if (e.verified === true) any = true;
  }
  return any;
}

function isLoginAccepted(status) {
  if (!status || typeof status !== "object") return false;
  if (status.ok === false || status.verified === false) return false;
  if (status.verified === true) return true;
  return identitiesVerified(status.identities);
}

/** ② 登录检测：执行 `<cli> auth status --json --verify`，按 verified 证据判已登录 */
async function isLarkLoggedIn(cliPath) {
  const r = await spawnRaw(cliPath, ["auth", "status", "--json", "--verify"], LOGIN_ENV, PROBE_TIMEOUT_MS);
  if (r.exit !== 0) {
    return { loggedIn: false, detail: (r.stderr || r.stdout).trim().slice(0, 200) };
  }
  const status = parseJsonOutput(r.stdout);
  if (isLoginAccepted(status)) {
    return { loggedIn: true, detail: "" };
  }
  const brief = status ? JSON.stringify(status) : (r.stdout || r.stderr).trim();
  return { loggedIn: false, detail: `${String(brief).slice(0, 160) || "无输出"}` };
}

/** 一次完整检测（两步直查）：LARK_CLI 显式指定优先，否则直接执行 PATH 中的 lark-cli */
async function probeResolve() {
  const envPath = process.env.LARK_CLI;
  const cliPath = envPath || DEFAULT_COMMAND;
  const isEnv = Boolean(envPath);
  // 成功时 source 标识来源（env / path）；失败沿用旧语义：PATH 直查无可用 CLI 记 "none"
  const okSource = isEnv ? "env" : "path";
  const failSource = isEnv ? "env" : "none";
  if (!(await isLarkCliInstalled(cliPath))) {
    return {
      available: false,
      source: failSource,
      path: cliPath,
      reason: isEnv
        ? "LARK_CLI 指向的 CLI 无法执行（--version 失败）：确认路径后无需重启，检测会自动重试"
        : "未找到可执行的 lark-cli（--version 失败）：请安装 lark CLI，或用 LARK_CLI 环境变量显式指定",
    };
  }
  const login = await isLarkLoggedIn(cliPath);
  if (!login.loggedIn) {
    return {
      available: false,
      source: failSource,
      path: cliPath,
      reason: `lark-cli 已安装但未通过登录检测（auth status --json --verify）：${login.detail}`,
    };
  }
  return { available: true, source: okSource, path: cliPath };
}

/** 解析并缓存结果：成功永久；失败短 TTL 后重探；并发调用共享同一次探测 */
async function resolveCli() {
  if (resolved) return resolved;
  if (failed && Date.now() < failed.expiresAt) return failed.result;
  if (!inflight) {
    inflight = probeResolve()
      .catch(() => ({ available: false, source: "none", path: null }))
      .finally(() => (inflight = null));
  }
  const result = await inflight;
  if (result.available) resolved = result;
  else failed = { result, expiresAt: Date.now() + probeRetryMs() };
  return result;
}

/** 一次探测失败后的缓存时长：显式 0 生效（每次调用重探），默认 30s */
function probeRetryMs() {
  const v = Number(process.env.LARK_PROBE_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : PROBE_RETRY_DEFAULT_MS;
}

/** doc 类子命令的信封执行：{ code, msg, data }，code 0 成功；崩溃、非法 JSON、超时都兜住 */
async function runEnvelope(cliPath, args, timeoutMs) {
  const r = await spawnRaw(cliPath, args, {}, timeoutMs);
  if (r.timedOut) {
    return { ok: false, code: -1, msg: `lark CLI 执行超时（>${timeoutMs}ms）`, data: null };
  }
  if (r.error) {
    return { ok: false, code: -1, msg: r.stderr.slice(0, 200), data: null };
  }
  const envelope = parseJsonOutput(r.stdout);
  if (envelope && typeof envelope.code === "number") {
    return { ok: envelope.code === 0, code: envelope.code, msg: envelope.msg, data: envelope.data };
  }
  return {
    ok: false,
    code: -1,
    msg: `lark CLI 输出无法解析: ${(r.stderr || r.stdout).slice(0, 200)}`,
    data: null,
  };
}

/** 当前 CLI 状态（供 /api/health 展示；未解析时触发一次探测，失败短 TTL 后自动重探） */
async function cliStatus() {
  return resolveCli();
}

/** 检测门：通过则返回 { ok: true, path }；未检测到可用 CLI 时不执行任何命令，返回友好提示 */
async function gateCommand() {
  const status = await resolveCli();
  if (status.available) return { ok: true, path: status.path };
  const reason = status.reason ? `最近检测：${status.reason}` : "";
  return {
    ok: false,
    code: -2,
    msg:
      "未检测到已安装并登录的 lark CLI：解析飞书/Lark 文档需要本地 lark-cli 通过两步检测" +
      "（`--version` 可执行、`auth status --json --verify` 确认已登录）。请安装并登录后重试，" +
      "或用 LARK_CLI 环境变量显式指定；检测失败后会自动重试，无需重启。" +
      reason,
    data: null,
  };
}

/**
 * 信封执行：doc 类子命令按 { code, msg, data } 解析，返回统一结果 { ok, code, msg, data }。
 * CLI 崩溃、输出非法 JSON、超时都会被兜住，不会让服务端抛异常。
 * 不限制子命令——信封只是输出解读约定，命令面由调用方决定。
 */
async function runLarkCli(args, timeoutMs = 10000) {
  const gate = await gateCommand();
  if (!gate.ok) return gate;
  return runEnvelope(gate.path, args, timeoutMs);
}

/**
 * 原始透传执行：不限制子命令、不解析输出，stdout/stderr/退出码原样返回，
 * 供 pi agent 的通用 lark_cli 工具自行探索真实命令面（如 --help、docs fetch）并解读输出。
 * 与 runLarkCli 共用同一检测门（code -2 友好提示）；超时/启动失败兜底为 ok:false。
 */
async function runLarkCommand(args, timeoutMs = 30000) {
  const gate = await gateCommand();
  if (!gate.ok) return { ...gate, exit: null, stdout: "", stderr: "" };
  const r = await spawnRaw(gate.path, args, {}, timeoutMs);
  return {
    ok: !r.error && !r.timedOut && r.exit === 0,
    code: r.error || r.timedOut ? -1 : r.exit,
    exit: r.exit,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut || undefined,
    msg: r.timedOut
      ? `lark CLI 执行超时（>${timeoutMs}ms）`
      : r.error
        ? `lark CLI 启动失败: ${r.stderr}`
        : r.exit === 0
          ? "success"
          : (r.stderr || r.stdout).trim().slice(0, 200) || `退出码 ${r.exit}`,
    data: null,
  };
}

module.exports = { runLarkCli, runLarkCommand, cliStatus };
