/** agent.js 纯函数测试：链接提取、章节切分与选段、超限识别 */
const test = require("node:test");
const assert = require("node:assert");
const { extractTokens, splitSections, sectionScore, docExcerpt, isOverflowError } = require("../src/agent");

test("extractTokens：链接 / wiki / 裸 token / 去重 / 上限 3 篇", () => {
  assert.deepEqual(extractTokens("帮我总结 https://demo.feishu.cn/docx/doccnABC123xyz"), ["doccnABC123xyz"]);
  // 完整链接先提取（LARK_URL_RE），裸 token 其次（BARE_TOKEN_RE），顺序确定
  assert.deepEqual(extractTokens("看下 https://xx.feishu.cn/wiki/wikiTOKEN001 和 doccnBARE00001"), [
    "wikiTOKEN001",
    "doccnBARE00001",
  ]);
  assert.deepEqual(
    extractTokens("https://a.feishu.cn/docx/doccnAAA11111 https://a.feishu.cn/docx/doccnAAA11111"),
    ["doccnAAA11111"],
    "重复链接去重"
  );
  const many = extractTokens(
    "https://a.feishu.cn/docx/doccnAAA11111 https://a.feishu.cn/docx/doccnBBB22222 https://a.feishu.cn/docx/doccnCCC33333 https://a.feishu.cn/docx/doccnDDD44444"
  );
  assert.equal(many.length, 3, "单条消息最多处理 3 篇");
});

test("splitSections 按标题切片，sectionScore 标题权重高于正文", () => {
  const md = "# 一级标题\n\n开篇内容\n\n## 里程碑\n\nM1 计划如下\n\n## 其他\n\n无关内容";
  const sections = splitSections(md);
  assert.equal(sections.length, 3);
  const byHeading = new Map(sections.map((s) => [s.heading, s]));
  const q = "里程碑计划";
  assert.ok(sectionScore(byHeading.get("里程碑"), q) > 0);
  assert.ok(
    sectionScore(byHeading.get("里程碑"), q) > sectionScore(byHeading.get("其他"), q),
    "标题命中的章节得分应更高"
  );
});

test("docExcerpt：长文档按问题选段并附大纲，节选规模受预算约束", () => {
  const long = Array.from({ length: 12 }, (_, i) => `## 章节${i}\n\n${"内容".repeat(600)}\n`).join("\n");
  const doc = { title: "长文档", content: long };
  const budget = 2000;
  const excerpt = docExcerpt(doc, "章节3 相关的问题", budget);
  assert.ok(excerpt.includes("全文大纲"), "应附全文大纲");
  assert.ok(excerpt.length < long.length, "节选应显著小于全文");
  assert.ok(excerpt.length <= budget + 400, "节选规模受预算约束（大纲开销略有富余）");
  assert.ok(excerpt.includes("章节3"), "应选中与问题相关的章节");
});

test("isOverflowError 识别常见超限报错措辞", () => {
  assert.ok(isOverflowError(new Error("HTTP 400: This model's maximum context length is 8192 tokens")));
  assert.ok(isOverflowError(new Error("context_length_exceeded")));
  assert.ok(!isOverflowError(new Error("LLM 返回内容为空")));
});
