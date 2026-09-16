/** llm-config.js：配置归一化、打码与默认模式测试（落盘指向临时文件） */
process.env.LLM_CONFIG_FILE = "/tmp/lark-test-llm-config.json";
delete process.env.AGENT_MODE; // 验证 pi 默认
const fs = require("fs");
fs.rmSync(process.env.LLM_CONFIG_FILE, { force: true });

const test = require("node:test");
const assert = require("node:assert");
const llmConfig = require("../src/llm-config");

test("全新安装默认 Agent 模式为 pi", () => {
  assert.equal(llmConfig.publicConfig().agentMode, "pi");
});

test("setConfig：空 apiKey 保持原值，非法枚举被拒绝", () => {
  llmConfig.setConfig({ apiKey: "sk-test-1234567890", baseUrl: "http://example.com/v1/", model: "m1", agentMode: "pi" });
  const before = llmConfig.getConfig();
  assert.equal(before.apiKey, "sk-test-1234567890");
  assert.equal(before.baseUrl, "http://example.com/v1", "baseUrl 去尾斜杠");

  llmConfig.setConfig({ apiKey: "", model: "m2", apiType: "chat" });
  const cfg = llmConfig.getConfig();
  assert.equal(cfg.apiKey, "sk-test-1234567890", "空 Key = 保持不变");
  assert.equal(cfg.model, "m2");

  llmConfig.setConfig({ apiType: "nope", agentMode: "hacker", baseUrl: "" });
  assert.equal(llmConfig.getConfig().apiType, "chat", "非法枚举被拒绝");
  assert.equal(llmConfig.getConfig().agentMode, "pi", "非法 agentMode 被拒绝");
});

test("mergeConfig 合并出临时配置且不污染当前配置", () => {
  const current = llmConfig.getConfig();
  const merged = llmConfig.mergeConfig({ baseUrl: "http://tmp.example/v1/", model: "tmp" });
  assert.equal(merged.baseUrl, "http://tmp.example/v1");
  assert.equal(merged.model, "tmp");
  assert.equal(llmConfig.getConfig().model, current.model, "当前配置不受影响");
  assert.equal(llmConfig.getConfig().baseUrl, current.baseUrl);
});

test("publicConfig 不含明文 Key", () => {
  const pub = llmConfig.publicConfig();
  assert.ok(!("apiKey" in pub));
  assert.ok(pub.hasKey);
  assert.ok(pub.keyMasked.includes("****"));
});
