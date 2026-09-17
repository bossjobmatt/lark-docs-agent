const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./store");
const agent = require("./agent");
const llm = require("./llm");
const llmConfig = require("./llm-config");
const piAgent = require("./pi-agent");
const { runLarkCli, cliStatus } = require("./lark");
const protocol = require("./protocol");

const PORT = Number(process.env.PORT) || 3737;
const HOST = process.env.HOST || "127.0.0.1"; // 默认只绑定本机，避免内网暴露
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}

function sendFile(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "not found" });
    send(res, 200, buf, MIME[path.extname(name)] || "application/octet-stream");
  });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    // 静态资源（public/ 下任意文件；sendFile 内含路径穿越防护，API 路由优先于此后判断）
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      return sendFile(res, name);
    }

    // 健康检查 / 模式探测
    if (req.method === "GET" && url.pathname === "/api/health") {
      const configured = llmConfig.isConfigured();
      const cfg = llmConfig.publicConfig();
      const lark = await cliStatus();
      return send(res, 200, {
        ok: true,
        mode: configured ? "llm" : "sim",
        model: configured ? cfg.model : null,
        apiType: cfg.apiType,
        agentMode: cfg.agentMode,
        piAvailable: cfg.agentMode === "pi" ? await piAgent.isAvailable() : null,
        lark: { available: lark.available, source: lark.source, path: lark.path, reason: lark.reason || null },
        time: new Date().toISOString(),
      });
    }

    // LLM 配置：读取（Key 打码）/ 保存 / 恢复默认
    if (req.method === "GET" && url.pathname === "/api/llm/config") {
      return send(res, 200, llmConfig.publicConfig());
    }
    if (req.method === "POST" && url.pathname === "/api/llm/config") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const cfg = llmConfig.setConfig(body);
      piAgent.syncConfig(); // pi 模式：凭据变化时立即刷新自有 agentDir
      return send(res, 200, { ok: true, config: cfg, mode: llmConfig.isConfigured() ? "llm" : "sim" });
    }
    if (req.method === "POST" && url.pathname === "/api/llm/config/reset") {
      const cfg = llmConfig.resetConfig();
      piAgent.syncConfig();
      return send(res, 200, { ok: true, config: cfg, mode: llmConfig.isConfigured() ? "llm" : "sim" });
    }
    // 连接测试：用表单当前值（Key 留空则用已存值）发一条真实请求
    if (req.method === "POST" && url.pathname === "/api/llm/test") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        return send(res, 200, await llm.test(body));
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    // 拉取 OpenAI 兼容模型列表（GET {baseUrl}/models）
    if (req.method === "POST" && url.pathname === "/api/llm/models") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        return send(res, 200, { ok: true, models: await llm.listModels(body) });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    // 示例文档：真实地通过 lark CLI `doc list` 取得
    if (req.method === "GET" && url.pathname === "/api/examples") {
      const r = await runLarkCli(["doc", "list"]);
      return send(res, 200, { ok: r.ok, items: r.ok ? r.data.items : [] });
    }

    // 多轮对话历史
    if (req.method === "GET" && url.pathname === "/api/history") {
      const session = store.get(url.searchParams.get("sessionId"));
      return send(res, 200, { messages: session ? session.messages : [] });
    }

    // 发送消息（核心接口，响应已瘦身：前端本地维护消息列表，不再回传全量 history）
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const message = String(body.message || "").trim();
      if (!message) return send(res, 400, { error: "message 不能为空" });

      const session = store.getOrCreate(body.sessionId);
      const t0 = Date.now();
      const reply = await agent.handle(message, session);
      console.log(`[chat] sid=${session.id.slice(0, 8)} mode=${reply.mode} ${Date.now() - t0}ms`);
      return send(res, 200, {
        sessionId: session.id,
        mode: reply.mode,
        message: reply,
      });
    }

    // 发送消息（流式：NDJSON 事件行 —— start / tool / delta / done / error）
    if (req.method === "POST" && url.pathname === "/api/chat/stream") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const message = String(body.message || "").trim();
      if (!message) return send(res, 400, { error: "message 不能为空" });

      const session = store.getOrCreate(body.sessionId);
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      });
      const writeEvent = (evt) => {
        try {
          res.write(JSON.stringify(evt) + "\n");
        } catch {
          /* 连接已断开，忽略 */
        }
      };
      writeEvent(protocol.startEvent(session.id));

      const ac = new AbortController();
      res.on("close", () => ac.abort()); // 客户端断开时中止上游 LLM 请求

      const t0 = Date.now();
      try {
        const reply = await agent.handle(message, session, { onEvent: writeEvent, signal: ac.signal });
        console.log(`[chat/stream] sid=${session.id.slice(0, 8)} mode=${reply.mode} ${Date.now() - t0}ms`);
        writeEvent(protocol.doneEvent(session.id, reply));
      } catch (e) {
        writeEvent(protocol.errorEvent(e.message));
      } finally {
        res.end();
      }
      return;
    }

    // 会话列表（会话管理面板）
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return send(res, 200, { sessions: store.listSessions() });
    }

    // 删除会话（同时销毁 pi Agent 会话记忆）
    if (req.method === "POST" && url.pathname === "/api/session/delete") {
      const body = JSON.parse((await readBody(req)) || "{}");
      store.remove(body.sessionId);
      piAgent.dispose(body.sessionId);
      return send(res, 200, { ok: true });
    }

    // 清空会话（同时销毁 pi Agent 会话记忆）
    if (req.method === "POST" && url.pathname === "/api/session/clear") {
      const body = JSON.parse((await readBody(req)) || "{}");
      store.clear(body.sessionId);
      piAgent.dispose(body.sessionId);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// 启动日志的 Lark CLI 状态文案（四态：env 可用 / PATH 可用 / env 验证失败 / 未检测到）
function describeLarkStatus(lark) {
  if (lark.available) {
    return lark.source === "env" ? `${lark.path}（LARK_CLI 指定，已通过认证检查）` : `PATH 中的 lark（已认证）`;
  }
  if (lark.source === "env") {
    return `LARK_CLI 指定的 ${lark.path} 未通过认证检查（lark auth status）——修复后无需重启，检测会自动重试`;
  }
  return "未检测到已认证的 lark CLI —— 解析飞书文档需要本地安装并认证（LARK_CLI 或 PATH），检测失败后会自动重试";
}

server.listen(PORT, HOST, async () => {
  const cfg = llmConfig.publicConfig();
  const lark = await cliStatus();
  console.log(`Lark 文档助手已启动: http://${HOST}:${PORT}`);
  console.log(
    `Agent 模式: ${cfg.agentMode === "pi" ? "pi Agent（模型自主调用 lark CLI）" : "内置编排（服务端预取文档）"}`
  );
  console.log(
    `LLM: ${llmConfig.isConfigured() ? `${cfg.apiType} · ${cfg.model}` : "未配置（内置模式将以模拟回复运行）"}`
  );
  console.log(`Lark CLI: ${describeLarkStatus(lark)}`);
});
