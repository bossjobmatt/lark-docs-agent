/** AI 引擎配置弹窗：读取/保存/测试连接/恢复默认/模型列表 */
import { post } from "./api.js";
import { refreshHealth } from "./health.js";

const llmModal = document.getElementById("llm-modal");
const llmBtn = document.getElementById("llm-btn");
const llmType = document.getElementById("llm-type");
const llmBase = document.getElementById("llm-base");
const llmKey = document.getElementById("llm-key");
const llmModel = document.getElementById("llm-model");
const llmMsg = document.getElementById("llm-msg");
const llmFetchBtn = document.getElementById("llm-fetch-models");
const llmModelSelect = document.getElementById("llm-model-select");
const llmManualBtn = document.getElementById("llm-manual-model");
const llmAgentMode = document.getElementById("llm-agent-mode");

function setLlmMsg(text, cls) {
  llmMsg.textContent = text;
  llmMsg.className = `modal-msg ${cls || ""}`;
}

async function openLlmModal() {
  try {
    const c = await fetch("/api/llm/config").then((r) => r.json());
    llmAgentMode.value = c.agentMode || "pi";
    llmType.value = c.apiType || "chat";
    llmBase.value = c.baseUrl || "";
    llmModel.value = c.model || "";
    llmKey.value = "";
    llmKey.placeholder = c.hasKey ? `已配置（${c.keyMasked}），留空保持不变` : "sk-...";
  } catch {
    llmKey.placeholder = "sk-...";
  }
  setModelMode("input");
  setLlmMsg("");
  llmModal.classList.remove("hidden");
}

function closeLlmModal() {
  llmModal.classList.add("hidden");
}

function llmFormPayload() {
  const payload = { agentMode: llmAgentMode.value, apiType: llmType.value, baseUrl: llmBase.value.trim(), model: llmModel.value.trim() };
  const key = llmKey.value.trim();
  if (key) payload.apiKey = key; // 留空 = 保持已存 Key
  return payload;
}

// 注意：点击遮罩区域不关闭弹窗，避免误触丢失已填写的配置；仅「取消」按钮或 Esc 关闭
llmBtn.addEventListener("click", openLlmModal);
document.getElementById("llm-cancel").addEventListener("click", closeLlmModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !llmModal.classList.contains("hidden")) closeLlmModal();
});

document.getElementById("llm-save").addEventListener("click", async () => {
  try {
    const data = await post("/api/llm/config", llmFormPayload());
    setLlmMsg(`✓ 已保存并生效（${data.config.apiType} · ${data.config.model}）`, "ok");
    refreshHealth();
    setTimeout(closeLlmModal, 600);
  } catch (e) {
    setLlmMsg(`保存失败：${e.message}`, "err");
  }
});

document.getElementById("llm-test").addEventListener("click", async () => {
  setLlmMsg("正在测试连接…");
  try {
    const r = await post("/api/llm/test", llmFormPayload());
    setLlmMsg(`✓ 连接成功（${r.apiType} · ${r.model}，${r.latencyMs}ms）：${r.sample}`, "ok");
  } catch (e) {
    setLlmMsg(`✗ 连接失败：${e.message}`, "err");
  }
});

document.getElementById("llm-reset").addEventListener("click", async () => {
  try {
    await post("/api/llm/config/reset", {});
    setLlmMsg("已恢复默认（未配置 LLM，回到模拟模式）", "ok");
    refreshHealth();
    llmKey.value = "";
    llmKey.placeholder = "sk-...";
    setModelMode("input");
  } catch (e) {
    setLlmMsg(`重置失败：${e.message}`, "err");
  }
});

// ---------- 模型字段：select 下拉 / 手动输入双模式 ----------
function setModelMode(mode) {
  if (mode === "select") {
    llmModel.classList.add("hidden");
    llmModelSelect.classList.remove("hidden");
    llmManualBtn.classList.remove("hidden");
  } else {
    llmModelSelect.classList.add("hidden");
    llmModel.classList.remove("hidden");
    llmManualBtn.classList.add("hidden");
  }
}

// select 与隐藏 input 始终保持同值，保存逻辑只读 input
function fillModelSelect(models) {
  const current = llmModel.value.trim();
  const options = current && !models.includes(current) ? [current, ...models] : models;
  llmModelSelect.innerHTML = "";
  for (const m of options) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    llmModelSelect.appendChild(opt);
  }
  llmModelSelect.value = current;
}

llmModelSelect.addEventListener("change", () => {
  llmModel.value = llmModelSelect.value;
});

llmManualBtn.addEventListener("click", () => {
  setModelMode("input");
  llmModel.focus();
});

llmFetchBtn.addEventListener("click", async () => {
  const base = llmBase.value.trim();
  if (!base) {
    setLlmMsg("请先填写 Base URL 再拉取模型列表", "err");
    llmBase.focus();
    return;
  }
  llmFetchBtn.disabled = true;
  llmFetchBtn.textContent = "拉取中…";
  try {
    const r = await post("/api/llm/models", llmFormPayload());
    const models = r.models || [];
    if (!models.length) {
      setLlmMsg("⚠️ 网关返回了空模型列表，可切换为手动输入", "err");
      return;
    }
    fillModelSelect(models);
    setModelMode("select"); // 拉取成功即切换为下拉选择（否则 select 一直隐藏，提示与界面不符）
    setLlmMsg(`✓ 已拉取 ${models.length} 个模型，请在下拉列表中选择（或切换手动输入）`, "ok");
  } catch (e) {
    setLlmMsg(`✗ 拉取模型列表失败：${e.message}`, "err");
  } finally {
    llmFetchBtn.disabled = false;
    llmFetchBtn.textContent = "↻ 拉取列表";
  }
});
