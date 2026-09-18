/**
 * 模拟模式回答与文档文本匹配：无 LLM / LLM 失败降级时的本地规则回复，
 * 以及被 LLM 长文档节选复用的章节切分与相关度打分纯函数。
 */

/** 把 Markdown 按二级标题切片，用于模拟模式下按问题定位章节 */
function splitSections(md) {
  const sections = [];
  let cur = { heading: "开篇", body: [] };
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{2,6})\s+(.*)/);
    if (h) {
      if (cur.body.join("").trim()) sections.push(cur);
      cur = { heading: h[2].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join("").trim()) sections.push(cur);
  return sections;
}

/** 粗略关键词匹配打分：标题命中权重 x3，正文按 2-gram/词命中累计 */
function sectionScore(section, question) {
  const heading = section.heading.toLowerCase();
  const body = section.body.join("\n").toLowerCase();
  const cleaned = question.toLowerCase().replace(/[，。？！、,.?!（）()：:"'\s]+/g, " ");
  const grams = new Set();
  for (const w of cleaned.split(" ")) {
    if (w.length < 2) continue;
    grams.add(w);
    for (let i = 0; i < w.length - 1; i++) grams.add(w.slice(i, i + 2));
  }
  let score = 0;
  for (const g of grams) {
    if (heading.includes(g)) score += g.length * 3;
    if (body.includes(g)) score += g.length;
  }
  return score;
}

function outlineOf(md) {
  return md
    .split("\n")
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());
}

function excerpt(text, max = 420) {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + " …（截断）" : t;
}

function stripUrls(text) {
  // 只移除 URL 本身（域名字符 + 路径中的字母数字），不能贪吃到后续中文文本
  return String(text)
    .replace(/(?:https?:\/\/)?[a-zA-Z0-9-]+\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)(?:\/[A-Za-z0-9]+)+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 无 LLM 时的本地模拟回复：证明「取文档→回答」链路可用 */
function buildSimReply(question, session, images = []) {
  const docs = Object.values(session.docs);

  if (!docs.length) {
    const imgNote = images.length
      ? "\n\n🖼 检测到你发送了图片：模拟模式无法识图，配置支持视觉的 LLM（如 gpt-4o / GLM-4.5V）后即可图片问答。"
      : "";
    return [
      "你好！我是 **Lark 文档助手** 🤖，当前为**模拟模式**（未配置大模型 Key，回复由本地规则生成，用于演示完整链路）。",
      "",
      "工作流程：",
      "1. 在消息中粘贴飞书/Lark 文档链接（支持 feishu.cn / larksuite.com / larkoffice.com，也可直接输入 `doccn` 开头的 token）；",
      "2. 我会调用本地 Lark CLI（`lark doc get <链接>`）读取文档全文；",
      "3. 基于文档内容回答你的问题，同一会话内支持多轮追问，文档内容已缓存、不会重复拉取。",
      "",
      "试试：`帮我总结这份文档：https://demo.feishu.cn/docx/doccnABC123xyz`",
      "",
      "💡 配置 `LLM_API_KEY`（OpenAI 兼容）并重启服务，可获得真正的 AI 问答效果。",
      imgNote,
    ].join("\n");
  }

  const parts = [
    `已读取 **${docs.length}** 篇文档（当前为**模拟模式**，回答由本地规则匹配生成，仅供演示链路）：`,
    "",
  ];
  if (images.length) {
    parts.push(`🖼 检测到 ${images.length} 张图片：模拟模式无法识图，已忽略图片内容。`, "");
  }

  let anyMatch = false;

  for (const doc of docs) {
    const sections = splitSections(doc.content);
    const q = stripUrls(question) || "请总结这篇文档";
    let best = null;
    let bestScore = 0;
    for (const s of sections) {
      const score = sectionScore(s, q);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }

    parts.push(`---`, ``, `### 📄 《${doc.title}》`);
    if (best && bestScore >= 4) {
      anyMatch = true;
      parts.push(
        `**针对你的问题「${q.slice(0, 40)}」，定位到章节：${best.heading}**`,
        ``,
        excerpt(best.body.join("\n"))
      );
    } else {
      parts.push(`> 文档中没有找到与该问题直接相关的段落，以下是大纲供参考：`);
    }
    parts.push(``, `**文档大纲**：${outlineOf(doc.content).join(" / ")}`, ``);
  }

  parts.push(
    `---`,
    `多轮提示：你可以继续追问，例如「上线流程有哪些步骤？」「里程碑计划是什么？」（文档已在本会话缓存）。`
  );
  if (!anyMatch) parts.push(`提示：换一个与文档内容更相关的问题试试，或先发送文档链接。`);
  return parts.join("\n");
}

module.exports = { buildSimReply, splitSections, sectionScore, outlineOf, excerpt, stripUrls };
