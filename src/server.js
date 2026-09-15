const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./store");
const agent = require("./agent");
const llm = require("./llm");
const piAgent = require("./pi-agent");
const { runLarkCli } = require("./lark");

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
    // 静态资源
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return sendFile(res, "index.html");
    if (req.method === "GET" && url.pathname === "/style.css") return sendFile(res, "style.css");
    if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, "app.js");

    // 健康检查 / 模式探测
    if (req.method === "GET" && url.pathname === "/api/health") {
      const configured = llm.isConfigured();
      const cfg = llm.publicConfig();
      return send(res, 200, {
        ok: true,
        mode: configured ? "llm" : "sim",
        model: configured ? cfg.model : null,
        apiType: cfg.apiType,
        agentMode: cfg.agentMode,
        piAvailable: cfg.agentMode === "pi" ? await piAgent.isAvailable() : null,
        time: new Date().toISOString(),
      });
    }

    // LLM 配置：读取（Key 打码）/ 保存 / 恢复默认
    if (req.method === "GET" && url.pathname === "/api/llm/config") {
      return send(res, 200, llm.publicConfig());
    }
    if (req.method === "POST" && url.pathname === "/api/llm/config") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const cfg = llm.setConfig(body);
      piAgent.syncConfig(); // pi 模式：凭据变化时立即刷新自有 agentDir
      return send(res, 200, { ok: true, config: cfg, mode: llm.isConfigured() ? "llm" : "sim" });
    }
    if (req.method === "POST" && url.pathname === "/api/llm/config/reset") {
      const cfg = llm.resetConfig();
      piAgent.syncConfig();
      return send(res, 200, { ok: true, config: cfg, mode: llm.isConfigured() ? "llm" : "sim" });
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

    // 发送消息（核心接口）
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const message = String(body.message || "").trim();
      if (!message) return send(res, 400, { error: "message 不能为空" });

      const session = store.getOrCreate(body.sessionId);
      const reply = await agent.handle(message, session);
      store.persist();
      return send(res, 200, {
        sessionId: session.id,
        mode: reply.mode,
        message: reply,
        history: session.messages,
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
      writeEvent({ type: "start", sessionId: session.id });

      const ac = new AbortController();
      res.on("close", () => ac.abort()); // 客户端断开时中止上游 LLM 请求

      try {
        const reply = await agent.handle(message, session, { onEvent: writeEvent, signal: ac.signal });
        store.persist();
        writeEvent({ type: "done", sessionId: session.id, reply });
      } catch (e) {
        writeEvent({ type: "error", error: e.message });
      } finally {
        res.end();
      }
      return;
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

server.listen(PORT, HOST, () => {
  const cfg = llm.publicConfig();
  console.log(`Lark 文档助手已启动: http://${HOST}:${PORT}`);
  console.log(
    `Agent 模式: ${cfg.agentMode === "pi" ? "pi Agent（模型自主调用 lark CLI）" : "内置编排（服务端预取文档）"}`
  );
  console.log(
    `LLM: ${llm.isConfigured() ? `${cfg.apiType} · ${cfg.model}` : "未配置（内置模式将以模拟回复运行）"}`
  );
  console.log(`Lark CLI: ${process.env.LARK_CLI || "bin/lark（模拟实现）"}`);
});
