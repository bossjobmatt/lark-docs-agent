const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * lark CLI 的纯调用方约定：
 * - LARK_CLI 环境变量显式指向 CLI（真实或内置演示 mock bin/lark），优先级最高；
 * - 否则探测 PATH 中的 lark，且要求 `lark auth status` 返回 code 0（已认证）；
 * - 都没有 → 不回落任何内置实现，工具调用返回友好提示，由用户自行安装。
 * 本项目只调用 CLI，不做其安装与凭据配置。
 */
const PROBE_TIMEOUT_MS = 4000;
const NO_CLI_HINT =
  "未检测到本地已认证的 lark CLI：解析飞书/Lark 文档需要本地安装并完成认证，" +
  "安装后通过 LARK_CLI 环境变量指定路径，或确保 `lark auth status` 可用。";

let resolved = null; // { available, source, path } —— 启动后缓存

/** 读取文件首行，判断是否 node 脚本（无执行位的 JS CLI 需经 node 启动） */
function isNodeScript(cliPath) {
  try {
    const head = fs.readFileSync(cliPath, "utf8").slice(0, 64);
    return head.startsWith("#!") && head.includes("node");
  } catch {
    return false;
  }
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
    // 无执行位/非可执行格式的 node 脚本：回退经 node 启动（内置演示 mock 即此形态）
    direct.on("error", (e) => {
      direct.removeAllListeners("close"); // 避免 error 后 close 双触发抢先用空输出结算
      if (isNodeScript(cliPath)) {
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
      try {
        const envelope = JSON.parse(stdout.trim());
        finish({ ok: envelope.code === 0, code: envelope.code, msg: envelope.msg, data: envelope.data });
      } catch {
        finish({ ok: false, code: -1, msg: `lark CLI 输出无法解析: ${(stderr || stdout).slice(0, 200)}`, data: null });
      }
    };
    direct.on("close", onClose);
  });
}

/** 解析要使用的 CLI：LARK_CLI 显式指定 → PATH 探测（须通过 auth status 认证检查）→ 无 */
async function resolveCli() {
  if (resolved) return resolved;
  if (process.env.LARK_CLI) {
    resolved = { available: true, source: "env", path: process.env.LARK_CLI };
    return resolved;
  }
  try {
    const probe = await spawnCli("lark", ["auth", "status"], PROBE_TIMEOUT_MS);
    resolved =
      probe.ok && probe.data && probe.data.status === "ok"
        ? { available: true, source: "path", path: "lark" }
        : { available: false, source: "none", path: null, reason: probe.msg };
  } catch {
    resolved = { available: false, source: "none", path: null };
  }
  return resolved;
}

/** 当前 CLI 状态（供 /api/health 展示；未解析时触发一次解析） */
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
    return {
      ok: false,
      code: -2,
      msg:
        "解析飞书/Lark 文档需要本地安装并完成认证的 lark CLI：请安装后设置 LARK_CLI 环境变量指向它，" +
        "或确保 PATH 中的 `lark` 已通过 `lark auth status` 认证。当前未检测到可用 CLI。",
      data: null,
    };
  }
  return spawnCli(status.path, args, timeoutMs);
}

module.exports = { runLarkCli, cliStatus };
