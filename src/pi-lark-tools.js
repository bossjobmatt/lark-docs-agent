/**
 * pi Agent 的 lark 工具定义（defineTool 由 pi-agent.js 注入 pi SDK 的构造器）：
 * - lark_doc_get：按信封契约 { code, msg, data } 读文档（演示 mock 与自建 CLI 的约定命令面）；
 * - lark_cli：透传执行任意 lark CLI 子命令并回传原始输出——本机 lark-cli 命令面与约定不同时
 *   （如读取是 docs fetch 而非 doc get），由模型自行探索（--help）并调用实际存在的子命令。
 * 工具内部执行本地已安装并登录的 lark CLI（纯调用，不负责其安装配置）；不暴露 bash 等系统级执行面。
 */
const { Type } = require("typebox");
const { runLarkCli, runLarkCommand } = require("./lark");

const TOOL_NAME = "lark_doc_get";
const CLI_TOOL_NAME = "lark_cli";
// 通用工具回传给模型的输出上限：超长截断，避免撑爆上下文（lark.js 侧不做限制）
const CLI_OUTPUT_MAX_CHARS = 16000;

/** 通用 lark CLI 工具的返回文本：原始输出原样回传（超长截断），由模型自行解读 */
function formatCliOutput(res) {
  const parts = [`exit=${res.exit}`, `--- stdout ---`, res.stdout.trim() || "（空）"];
  if (res.stderr.trim()) parts.push(`--- stderr ---`, res.stderr.trim());
  const text = parts.join("\n");
  return text.length > CLI_OUTPUT_MAX_CHARS ? `${text.slice(0, CLI_OUTPUT_MAX_CHARS)}\n…（输出过长，已截断）` : text;
}

/** 构造 pi 会话可用的两个 lark 工具 */
function makeLarkTools(defineTool) {
  const larkDocGet = defineTool({
    name: TOOL_NAME,
    label: "Lark 文档读取",
    description:
      "读取飞书/Lark 文档全文（Markdown）。当用户消息包含 feishu.cn（国内版）、larksuite.com 或 larkoffice.com（国际版）的文档链接，或 doccn 开头的文档 token 时，用本工具获取内容。",
    parameters: Type.Object({
      doc: Type.String({ description: "飞书/Lark 文档链接或文档 token，例如 https://demo.feishu.cn/docx/doccnABC123xyz" }),
    }),
    execute: async (_toolCallId, params) => {
      const res = await runLarkCli(["doc", "get", params.doc]);
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Lark CLI 调用失败：${res.msg}` }],
          details: { summary: `调用失败：${res.msg}` },
        };
      }
      const d = res.data;
      return {
        content: [
          { type: "text", text: `【文档：《${d.title}》，更新于 ${d.update_time}，链接 ${d.url}】\n\n${d.content}` },
        ],
        details: { summary: `已读取《${d.title}》（${d.word_count} 字）` },
      };
    },
  });

  const larkCli = defineTool({
    name: CLI_TOOL_NAME,
    label: "Lark CLI 调用",
    description:
      "执行本地 lark CLI 的任意子命令，返回原始输出（stdout/stderr/退出码），不做解析与限制。" +
      "当 lark_doc_get 失败或本机 lark-cli 的命令面与之不同（例如读取文档是 docs fetch 而非 doc get）时，" +
      "先用本工具探索可用命令（如 --help），再调用实际存在的子命令并自行解读输出。" +
      "仅在解析 Lark 文档所需的范围内使用。",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: 'lark CLI 参数列表，例如 ["docs", "fetch", "https://demo.feishu.cn/docx/xxx"] 或 ["--help"]',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const args = Array.isArray(params.args) ? params.args.map(String) : [];
      const res = await runLarkCommand(args);
      const summary = res.code === -2 ? "lark CLI 不可用" : res.ok ? `已执行 lark ${args.join(" ")}`.slice(0, 80) : `执行失败（退出码 ${res.exit}）`;
      return {
        content: [{ type: "text", text: res.code === -2 ? res.msg : formatCliOutput(res) }],
        details: { summary },
      };
    },
  });

  return [larkDocGet, larkCli];
}

module.exports = { TOOL_NAME, CLI_TOOL_NAME, makeLarkTools };
