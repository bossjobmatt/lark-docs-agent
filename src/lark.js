const { spawn } = require("child_process");
const path = require("path");

// 通过 LARK_CLI 环境变量可无缝替换为真实 CLI（保持相同的 JSON 信封输出约定即可）
const CLI_PATH = process.env.LARK_CLI || path.join(__dirname, "..", "bin", "lark");

/**
 * 执行 lark CLI 子命令，返回统一结果 { ok, code, msg, data }。
 * CLI 崩溃、输出非法 JSON、超时都会被兜住，不会让服务端抛异常。
 */
function runLarkCli(args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

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

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish({ ok: false, code: -1, msg: `lark CLI 启动失败: ${e.message}`, data: null }));
    child.on("close", () => {
      try {
        const envelope = JSON.parse(stdout.trim());
        finish({ ok: envelope.code === 0, code: envelope.code, msg: envelope.msg, data: envelope.data });
      } catch {
        finish({ ok: false, code: -1, msg: `lark CLI 输出无法解析: ${(stderr || stdout).slice(0, 200)}`, data: null });
      }
    });
  });
}

module.exports = { runLarkCli };
