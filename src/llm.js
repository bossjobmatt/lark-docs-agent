/**
 * OpenAI 兼容 LLM 客户端：支持两种 API 类型
 *   - "chat"      Chat Completions（POST {baseUrl}/chat/completions）
 *   - "responses" Responses        （POST {baseUrl}/responses）
 *
 * 配置优先级：界面保存的配置（data/llm-config.json）> 环境变量 > 内置默认。
 * 环境变量（作为默认值）：LLM_API_KEY / OPENAI_API_KEY、LLM_BASE_URL / OPENAI_BASE_URL、
 * LLM_MODEL、LLM_API_TYPE。
 */
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "..", "data", "llm-config.json");

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

function extractResponseText(json) {
  // Responses API：优先从 output[].content[].output_text 拼接，兼容聚合字段 output_text
  let text = "";
  for (const item of json.output || []) {
    if (item && item.type === "message") {
      for (const c of item.content || []) {
        if (c && c.type === "output_text") text += c.text || "";
      }
    }
  }
  if (!text && typeof json.output_text === "string") text = json.output_text;
  return text;
}

async function chat(messages, { timeoutMs = 60000, cfg = config, signal } = {}) {
  const ac = signal ? null : new AbortController();
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  const endpoint = cfg.apiType === "responses" ? "/responses" : "/chat/completions";
  const body =
    cfg.apiType === "responses"
      ? { model: cfg.model, input: messages, temperature: 0.3 }
      : { model: cfg.model, messages, temperature: 0.3 };

  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: signal || (ac && ac.signal),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const json = await resp.json();
    const content =
      cfg.apiType === "responses" ? extractResponseText(json) : json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error("LLM 返回内容为空");
    return content;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`请求超时（>${timeoutMs}ms）`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 流式对话：入参与 chat() 相同，额外通过 onDelta(增量文本) 逐段回调，返回完整文本。
 * 超时策略：firstByteMs（等待首块）/ idleMs（两块之间空闲）比整体超时更贴合流式。
 */
async function chatStream(messages, { onDelta, timeoutMs = 120000, firstByteMs = 30000, idleMs = 30000, cfg = config, signal } = {}) {
  const ac = new AbortController();
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  const overall = setTimeout(() => ac.abort(), timeoutMs);
  let phase = "first-byte";
  let phaseTimer = setTimeout(() => ac.abort(), firstByteMs);
  const arm = (label, ms) => {
    phase = label;
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => ac.abort(), ms);
  };

  const endpoint = cfg.apiType === "responses" ? "/responses" : "/chat/completions";
  const body =
    cfg.apiType === "responses"
      ? { model: cfg.model, input: messages, temperature: 0.3, stream: true }
      : { model: cfg.model, messages, temperature: 0.3, stream: true };

  let full = "";
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    if (!resp.body) throw new Error("网关未返回流式响应体");

    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of resp.body) {
      arm("idle", idleMs);
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // 忽略无法解析的心跳/注释行
        }
        const delta =
          cfg.apiType === "responses"
            ? json.type === "response.output_text.delta"
              ? json.delta || ""
              : ""
            : (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) || "";
        if (!delta) continue;
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
    if (!full) throw new Error("LLM 流式返回内容为空");
    return full;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(signal && signal.aborted ? "客户端已取消" : `流式请求超时（${phase === "first-byte" ? `首字节 >${firstByteMs / 1000}s` : `空闲 >${idleMs / 1000}s`}）`);
    }
    throw e;
  } finally {
    clearTimeout(overall);
    clearTimeout(phaseTimer);
  }
}

/** 用传入（或当前）配置合并出一份临时配置，不污染当前配置 */
function mergeCfg(overrides = {}) {
  const tempCfg = { ...config };
  if (overrides.apiType === "chat" || overrides.apiType === "responses") tempCfg.apiType = overrides.apiType;
  if (overrides.baseUrl && String(overrides.baseUrl).trim()) tempCfg.baseUrl = String(overrides.baseUrl).trim().replace(/\/+$/, "");
  if (overrides.model && String(overrides.model).trim()) tempCfg.model = String(overrides.model).trim();
  if (overrides.apiKey && String(overrides.apiKey).trim()) tempCfg.apiKey = String(overrides.apiKey).trim();
  return tempCfg;
}

/** 用传入（或当前）配置发一条真实请求验证连通性；不落盘、不影响当前配置 */
async function test(overrides = {}) {
  const tempCfg = mergeCfg(overrides);
  const t0 = Date.now();
  const sample = await chat([{ role: "user", content: "连通性测试，请回复：连接成功" }], { timeoutMs: 15000, cfg: tempCfg });
  return { ok: true, apiType: tempCfg.apiType, model: tempCfg.model, latencyMs: Date.now() - t0, sample: sample.slice(0, 100) };
}

/** 拉取 OpenAI 兼容模型列表（GET {baseUrl}/models）；兼容 data[]/models[] 两种返回结构 */
async function listModels(overrides = {}) {
  const tempCfg = mergeCfg(overrides);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const headers = {};
    if (tempCfg.apiKey) headers.Authorization = `Bearer ${tempCfg.apiKey}`;
    const resp = await fetch(`${tempCfg.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const json = await resp.json();
    const items = Array.isArray(json && json.data) ? json.data : Array.isArray(json && json.models) ? json.models : [];
    const models = [
      ...new Set(
        items
          .map((m) => (typeof m === "string" ? m : (m && (m.id || m.name || m.model)) || ""))
          .map((s) => String(s).trim())
          .filter(Boolean)
      ),
    ].sort((a, b) => a.localeCompare(b));
    return models;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("拉取超时（>15s）");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, getApiKey, chat, chatStream, test, listModels, publicConfig, setConfig, resetConfig };
