#!/usr/bin/env node
/**
 * 真实 Lark CLI 适配器（bridge to `lark-cli`）。
 *
 * 把本项目的统一 CLI 约定翻译为真实 `lark-cli` 命令：
 *   本项目约定                                   →  lark-cli 实现
 *   lark doc get <url|token>                    →  wiki +node-get（解析 wiki token）+ docs +fetch（markdown）
 *   lark doc list                               →  docs +search（无目录类命令，用宽泛关键词近似）
 *   lark doc search <keyword>                   →  docs +search
 *
 * 输出保持与 bin/lark 相同的 JSON 信封 { code, msg, data }：
 *   code === 0 成功；非 0 时进程退出码为 1。src/lark.js 据此判定 ok。
 *
 * 用法：LARK_CLI=<repo>/bin/lark-real.js npm start
 */
const { execFile } = require("child_process");
const fs = require("fs");

const REAL_CLI = process.env.LARK_CLI_BIN || "lark-cli";
const AS = process.env.LARK_CLI_AS || "user"; // 身份：user | bot

function out(envelope) {
  // 必须同步写 fd 1：大 payload 时 process.stdout.write 是异步的，
  // 紧随的 process.exit() 会把未刷出的部分截断（实测只剩 64KB 管道缓冲）
  fs.writeSync(1, JSON.stringify(envelope) + "\n");
  process.exit(envelope.code === 0 ? 0 : 1);
}

function real(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(REAL_CLI, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      // 成功时信封在 stdout；失败时 lark-cli 把 {ok, error} 信封写到 stderr——一并解析以提取干净错误信息
      const raw = (stdout && stdout.trim()) || (stderr && stderr.trim());
      if (err && !raw) {
        return resolve({ ok: false, msg: (err.message || "lark-cli 执行失败").slice(0, 300) });
      }
      try {
        resolve({ ok: true, env: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, msg: `lark-cli 输出无法解析: ${(stderr || stdout).slice(0, 200)}` });
      }
    });
  });
}

function errOf(env, fallback) {
  const e = (env && env.error) || {};
  const missing = e.missing_scopes || e.missingScopes;
  const hint = missing ? `（缺少权限 scope: ${missing.join(", ")}）` : "";
  return `${e.message || (env && env._notice) || fallback}${hint}`;
}

// 与 agent.js 的提取规则一致：完整链接或裸 token
const URL_RE = /[a-zA-Z0-9-]+\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki)\/([A-Za-z0-9]+)/;

async function docGet(input) {
  const m = String(input).match(URL_RE);
  const token = m ? m[1] : (/^[A-Za-z0-9]{6,}$/.test(String(input).trim()) ? String(input).trim() : null);
  if (!token) return out({ code: 99991672, msg: "invalid argument: 缺少文档链接或 token" });

  const isWikiUrl = !!(m && /\/wiki\//.test(m[0]));
  const url = String(input).trim();
  const emit = (document, docToken, title) => {
    const content = document.content || "";
    // 标题优先级：wiki 节点标题 > 正文首个一级标题 > token
    const h1 = content.split("\n").find((l) => /^#\s+/.test(l));
    return out({
      code: 0,
      msg: "success",
      data: {
        token: docToken,
        title: title || (h1 ? h1.replace(/^#\s+/, "").trim() : token),
        url,
        owner: "",
        update_time: new Date().toISOString().replace("T", " ").slice(0, 16),
        word_count: content.replace(/\s/g, "").length,
        content,
      },
    });
  };
  const fetchDoc = (docToken) =>
    real(["docs", "+fetch", "--doc", docToken, "--doc-format", "markdown", "--detail", "simple", "--format", "json"]);

  let docToken = token;
  let title = "";

  if (isWikiUrl) {
    const node = await real(["wiki", "+node-get", "--node-token", url, "--as", AS, "--format", "json"]);
    if (!node.ok || !node.env.ok) {
      return out({ code: 230002, msg: `document not found or no permission: ${token}（wiki 节点解析失败: ${errOf(node.env, node.msg)}）` });
    }
    docToken = node.env.data.obj_token || token;
    title = node.env.data.title || "";
  }

  const fetched = await fetchDoc(docToken);
  if (fetched.ok && fetched.env.ok) {
    return emit((fetched.env.data && fetched.env.data.document) || {}, docToken, title);
  }

  // 裸 token 可能是 wiki 节点 token（docs +fetch 不一定能直取）：先解析 wiki 节点再取 obj_token 重试
  if (!isWikiUrl) {
    const node = await real(["wiki", "+node-get", "--node-token", token, "--as", AS, "--format", "json"]);
    if (node.ok && node.env.ok && node.env.data && node.env.data.obj_token) {
      const retried = await fetchDoc(node.env.data.obj_token);
      if (retried.ok && retried.env.ok) {
        return emit((retried.env.data && retried.env.data.document) || {}, node.env.data.obj_token, node.env.data.title || "");
      }
    }
  }

  return out({ code: 230002, msg: `document not found or no permission: ${token}（${errOf(fetched.env, fetched.msg)}）` });
}

async function docSearch(keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return out({ code: 99991672, msg: "invalid argument: 缺少搜索关键词" });
  const r = await real(["docs", "+search", "--query", kw, "--page-size", "10", "--as", AS, "--format", "json"]);
  if (!r.ok || !r.env.ok) return out({ code: 50001, msg: errOf(r.env, r.msg) });

  const results = (r.env.data && r.env.data.results) || [];
  const items = results
    .map((x) => {
      const meta = x.result_meta || {};
      return {
        token: (meta.url && meta.url.match(/\/(?:docx|wiki|docs)\/([A-Za-z0-9]+)/) || [])[1] || meta.token || "",
        title: String(meta.title || x.title_highlighted || "").replace(/<\/?h>/g, ""),
        url: meta.url || "",
        owner: meta.owner_name || "",
        update_time: meta.update_time_iso || "",
      };
    })
    .filter((item) => item.url);
  return out({ code: 0, msg: "success", data: { total: items.length, items } });
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  // 上游两步检测的第一步：`<cli> --version`，退出码 0 即已安装
  if (cmd === "--version" || cmd === "-v") {
    fs.writeSync(1, "lark-real-adapter 1.0.0 (bridge to real lark-cli)\n");
    process.exit(0);
  }

  if (cmd === "doc" && (sub === "get" || sub === "read")) return docGet(rest[0] || "");

  if (cmd === "doc" && sub === "search") return docSearch(rest.join(" "));

  if (cmd === "doc" && (sub === "list" || sub === "ls")) {
    // 真实 CLI 没有「列出我所有文档」的命令，用宽泛关键词搜索近似演示
    const r = await docSearch("文档");
    if (r.code !== 0) return out(r);
    return out({ code: 0, msg: "success", data: r.data });
  }

  if (cmd === "auth" && sub === "status") {
    // 上游两步检测的第二步：auth status --json --verify，按 verified 证据判登录。
    // 翻译真实 lark-cli 的 { appId, identities } 输出为上游判据认可的形态：
    // 顶层 { ok, verified } + identities.<as>.verified/userName（userName 供 health 展示登录账号）
    const r = await real(["auth", "status"], 15000);
    if (!r.ok) {
      fs.writeSync(1, JSON.stringify({ ok: false, verified: false, error: r.msg }) + "\n");
      process.exit(1);
    }
    const env = r.env || {};
    const id = (env.identities && env.identities[AS]) || {};
    const ready = id.status === "ready" && id.available;
    fs.writeSync(1, JSON.stringify({
      ok: ready,
      verified: ready,
      appId: env.appId || "",
      identities: {
        [AS]: { status: ready ? "ready" : "error", verified: ready, userName: id.userName || "" },
      },
    }) + "\n");
    process.exit(ready ? 0 : 1);
  }

  out({
    code: 99991661,
    msg: `unknown command: ${[cmd, sub].filter(Boolean).join(" ")}（可用: auth status / doc list / doc get <url|token> / doc search <kw>）`,
  });
}

main().catch((e) => out({ code: 50001, msg: e.message }));
