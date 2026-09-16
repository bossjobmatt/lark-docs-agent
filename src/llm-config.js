/**
 * LLM 配置管理：界面保存 > 环境变量 > 内置默认，落盘 data/llm-config.json。
 * 环境变量（作为未配置时的默认值）：LLM_API_KEY / OPENAI_API_KEY、LLM_BASE_URL / OPENAI_BASE_URL、
 * LLM_MODEL、LLM_API_TYPE、AGENT_MODE；LLM_CONFIG_FILE 可覆盖落盘路径（测试用）。
 * 客户端实现见 llm.js。
 */
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = process.env.LLM_CONFIG_FILE || path.join(__dirname, "..", "data", "llm-config.json");

const DEFAULTS = {
  apiType: process.env.LLM_API_TYPE || "chat", // "chat" | "responses"
  baseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
  model: process.env.LLM_MODEL || "gpt-4o-mini",
  agentMode: process.env.AGENT_MODE === "pi" ? "pi" : "builtin", // "builtin" | "pi"
};

function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

let config = { ...DEFAULTS, ...loadFile() };

function persist() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("[llm] 配置持久化失败:", e.message);
  }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return key.slice(0, 3) + "****" + key.slice(-4);
}

/** 对外安全的配置视图（不返回明文 Key） */
function publicConfig() {
  const { apiType, baseUrl, model, apiKey, agentMode } = config;
  return { apiType, baseUrl, model, hasKey: Boolean(apiKey), keyMasked: maskKey(apiKey), agentMode };
}

/** 保存配置；apiKey 为空字符串表示保持原值不变 */
function setConfig(patch = {}) {
  const next = { ...config };
  if (patch.apiType === "chat" || patch.apiType === "responses") next.apiType = patch.apiType;
  if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
  if (typeof patch.model === "string" && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (patch.agentMode === "pi" || patch.agentMode === "builtin") next.agentMode = patch.agentMode;
  config = next;
  persist();
  return publicConfig();
}

/** 清除界面保存的配置，回落到环境变量/默认值 */
function resetConfig() {
  config = { ...DEFAULTS };
  try {
    fs.unlinkSync(CONFIG_FILE);
  } catch {
    /* 本来就没有 */
  }
  return publicConfig();
}

const isConfigured = () => Boolean(config.apiKey);
/** 内部用途：读取明文 Key（如 pi 模式生成自有 provider 配置时） */
const getApiKey = () => config.apiKey;
/** 供 llm 客户端读取当前完整配置（含明文 Key，勿外发） */
const getConfig = () => config;

/** 用传入（或当前）配置合并出一份临时配置，不污染当前配置 */
function mergeCfg(overrides = {}) {
  const tempCfg = { ...config };
  if (overrides.apiType === "chat" || overrides.apiType === "responses") tempCfg.apiType = overrides.apiType;
  if (overrides.baseUrl && String(overrides.baseUrl).trim()) tempCfg.baseUrl = String(overrides.baseUrl).trim().replace(/\/+$/, "");
  if (overrides.model && String(overrides.model).trim()) tempCfg.model = String(overrides.model).trim();
  if (overrides.apiKey && String(overrides.apiKey).trim()) tempCfg.apiKey = String(overrides.apiKey).trim();
  return tempCfg;
}

module.exports = { isConfigured, getApiKey, getConfig, publicConfig, setConfig, resetConfig, mergeCfg };
