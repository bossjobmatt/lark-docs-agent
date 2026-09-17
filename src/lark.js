const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * lark CLI 的纯调用方约定：
 * - LARK_CLI 环境变量显式指向 CLI（真实或演示 mock fixtures/lark-demo/lark），优先级最高；
 * - 否则依次探测 PATH 中的 lark 与兜底候选（默认 /opt/homebrew/bin、/usr/local/bin，
 *   可用 LARK_PATH_FALLBACKS 覆盖，空串禁用——launchd/GUI 启动时进程 PATH 往往不含用户安装目录），
 *   候选须通过 `lark auth status` 认证检查；按信封约定 code 0 即视为成功，不深挖 data 内部字段；
 * - 都没有 → 不回落任何内置实现，工具调用返回友好提示，由用户自行安装。
 * 探测结果缓存：成功永久；失败按 LARK_PROBE_RETRY_MS（默认 30s，显式 0 = 每次重探）
 * 短期缓存后自动重试——启动后才安装/认证 CLI 无需重启即可被检测到。
 * 本项目只调用 CLI，不做其安装与凭据配置。
 */
const PROBE_TIMEOUT_MS = 4000;
const PROBE_RETRY_DEFAULT_MS = 30000;
const DEFAULT_PATH_FALLBACKS = ["/opt/homebrew/bin/lark", "/usr/local/bin/lark"];

let resolved = null; // { available: true, source, path } —— 成功结果永久缓存
let failed = null; // { result, expiresAt } —— 失败结果短 TTL 缓存，到期重探
let inflight = null; // 并发首次探测去重

/** 读取文件首行，判断是否 node 脚本（无执行位的 JS CLI 需经 node 启动） */
function isNodeScript(cliPath) {
  try {
    const head = fs.readFileSync(cliPath, "utf8").slice(0, 64);
    return head.startsWith("#!") && head.includes("node");
  } catch {
    return false;
  }
}

/** 解析 stdout 信封；整体解析失败时容忍非 JSON 前缀（如自更新提示），从首个 { 截取重试 */
function parseEnvelope(stdout) {
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

function spawnCli(cliPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const direct = spawn(cliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = direct;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: -1, msg: `lark CLI 执行超时（>${timeoutMs}ms）`, data: null });
    }, timeoutMs);

    direct.stdout.on("data", (d) => (stdout += d));
    direct.stderr.on("data", (d) => (stderr += d));
    // 无执行位/非可执行格式的 node 脚本：回退经 node 启动（内置演示 mock 即此形态）。
    // 仅对路径形态的 cliPath 启用——裸名（如 "lark"）由 execvp 按 PATH 解析，
    // 若再按 CWD 相对读取同名文件，会误执行工作目录下的脚本。
    direct.on("error", (e) => {
      direct.removeAllListeners("close"); // 避免 error 后 close 双触发抢先用空输出结算
      if (cliPath.includes("/") && isNodeScript(cliPath)) {
        child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", onClose);
        child.on("error", (e2) => finish({ ok: false, code: -1, msg: `lark CLI 启动失败: ${e2.message}`, data: null }));
      } else {
        finish({ ok: false, code: -1, msg: `lark CLI 启动失败: ${e.message}`, data: null });
      }
    });

    const onClose = () => {
      const envelope = parseEnvelope(stdout);
      if (envelope && typeof envelope.code === "number") {
        finish({ ok: envelope.code === 0, code: envelope.code, msg: envelope.msg, data: envelope.data });
      } else {
        finish({ ok: false, code: -1, msg: `lark CLI 输出无法解析: ${(stderr || stdout).slice(0, 200)}`, data: null });
      }
    };
    direct.on("close", onClose);
  });
}

/** 一次探测失败后的缓存时长：显式 0 生效（每次调用重探），默认 30s */
function probeRetryMs() {
  const v = Number(process.env.LARK_PROBE_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : PROBE_RETRY_DEFAULT_MS;
}

/** PATH 探测失败后的兜底候选（冒号分隔）；显式空串禁用（测试封闭性用） */
function pathFallbacks() {
  const raw = process.env.LARK_PATH_FALLBACKS;
  if (raw !== undefined) return raw ? raw.split(":").filter(Boolean) : [];
  return DEFAULT_PATH_FALLBACKS;
}

/** 一次完整解析：LARK_CLI 显式指定（同样须通过认证检查）→ PATH 探测与常见位置兜底 → 无 */
async function probeResolve() {
  const envPath = process.env.LARK_CLI;
  if (envPath) {
    const probe = await spawnCli(envPath, ["auth", "status"], PROBE_TIMEOUT_MS);
    return probe.ok
      ? { available: true, source: "env", path: envPath }
      : {
          available: false,
          source: "env",
          path: envPath,
          reason: `LARK_CLI 指向的 CLI 未通过认证检查（lark auth status）：${probe.msg}`,
        };
  }
  const candidates = ["lark", ...pathFallbacks()];
  let reason = "未找到 lark CLI";
  for (const candidate of candidates) {
    const probe = await spawnCli(candidate, ["auth", "status"], PROBE_TIMEOUT_MS);
    if (probe.ok) return { available: true, source: "path", path: candidate };
    reason = probe.msg;
  }
  return { available: false, source: "none", path: null, reason };
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

/** 当前 CLI 状态（供 /api/health 展示；未解析时触发一次探测，失败短 TTL 后自动重探） */
async function cliStatus() {
  return resolveCli();
}

/**
 * 执行 lark CLI 子命令，返回统一结果 { ok, code, msg, data }。
 * CLI 崩溃、输出非法 JSON、超时都会被兜住，不会让服务端抛异常。
 * 未检测到可用 CLI 时不执行任何命令，直接返回友好提示（前端徽标与回复原样透出）。
 */
async function runLarkCli(args, timeoutMs = 10000) {
  const status = await resolveCli();
  if (!status.available) {
    const reason = status.reason ? `最近检测：${status.reason}` : "";
    return {
      ok: false,
      code: -2,
      msg:
        "解析飞书/Lark 文档需要本地安装并完成认证的 lark CLI：请安装后设置 LARK_CLI 环境变量指向它，" +
        "或确保 PATH 中的 `lark` 已通过 `lark auth status` 认证。当前未检测到可用 CLI，" +
        `检测失败后会自动重试，无需重启。${reason}`,
      data: null,
    };
  }
  return spawnCli(status.path, args, timeoutMs);
}

module.exports = { runLarkCli, cliStatus };
