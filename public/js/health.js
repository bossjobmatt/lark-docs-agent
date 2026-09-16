/** 模式徽标与健康检查 */
import { state } from "./state.js";

const badgeEl = document.getElementById("mode-badge");

export function updateBadge(mode, model, agentMode, lark) {
  if (agentMode === "pi") {
    badgeEl.className = "badge";
    badgeEl.textContent = "pi Agent 模式";
  } else if (mode === "llm") {
    badgeEl.className = "badge";
    badgeEl.textContent = `LLM 模式${model ? ` · ${model}` : ""}`;
  } else {
    badgeEl.className = "badge sim";
    badgeEl.textContent = "模拟模式（未配置 LLM）";
  }
  if (lark && !lark.available) {
    badgeEl.className = "badge sim";
    badgeEl.title = "解析飞书/Lark 文档需要本地安装并认证 lark CLI（LARK_CLI 环境变量或 PATH 中的 lark）。";
    badgeEl.textContent += " · 未检测到 lark CLI";
  }
}

export async function refreshHealth() {
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    state.lastHealth = health;
    updateBadge(health.mode, health.model, health.agentMode, health.lark);
    if (health.agentMode === "pi" && health.piAvailable === false) {
      badgeEl.textContent = "pi Agent 模式（SDK 未安装，将降级）";
      badgeEl.className = "badge sim";
    }
  } catch {
    badgeEl.textContent = "服务未连接";
  }
}
