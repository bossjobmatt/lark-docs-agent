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
  // lark CLI 与 pi SDK 状态各自独立成 chip，仅异常时显示
  larkEl.classList.toggle("hidden", !(lark && !lark.available));
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
