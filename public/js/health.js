/** 模式徽标与健康检查：三个独立 chip（模式 / lark CLI 状态 / pi SDK 状态），按需显示 */
import { state } from "./state.js";

const modeEl = document.getElementById("badge-mode");
const larkEl = document.getElementById("badge-lark");
const piEl = document.getElementById("badge-pi");

export function updateBadge(mode, model, agentMode, lark, piAvailable) {
  if (agentMode === "pi") {
    modeEl.className = "badge";
    modeEl.textContent = "pi Agent 模式";
  } else if (mode === "llm") {
    modeEl.className = "badge";
    modeEl.textContent = `LLM 模式${model ? ` · ${model}` : ""}`;
  } else {
    modeEl.className = "badge";
    modeEl.textContent = "模拟模式（未配置 LLM）";
  }
  // lark CLI 三态常显：已连接（含登录账号/来源）/ 未连接（悬停看 reason）；pi SDK 仅异常时显示
  if (!lark) {
    larkEl.className = "badge sim hidden";
  } else if (lark.available) {
    larkEl.className = "badge ok";
    larkEl.textContent = `lark CLI 已连接 · ${lark.account || lark.path || "lark-cli"}${lark.source === "env" ? "（LARK_CLI）" : ""}`;
    larkEl.title = `解析飞书/Lark 文档将经由该 CLI 执行（来源：${lark.source === "env" ? "LARK_CLI 环境变量" : "PATH 探测"}，路径：${lark.path || "lark-cli"}）`;
  } else {
    larkEl.className = "badge sim";
    larkEl.textContent = "lark CLI 未连接";
    larkEl.title = lark.reason || "解析飞书/Lark 文档需要本地安装并认证 lark CLI；检测失败会自动重试，装好即恢复";
  }
  piEl.classList.toggle("hidden", !(agentMode === "pi" && piAvailable === false));
}

export async function refreshHealth() {
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    state.lastHealth = health;
    updateBadge(health.mode, health.model, health.agentMode, health.lark, health.piAvailable);
  } catch {
    modeEl.textContent = "服务未连接";
    modeEl.className = "badge sim";
    larkEl.classList.add("hidden");
    piEl.classList.add("hidden");
  }
}
