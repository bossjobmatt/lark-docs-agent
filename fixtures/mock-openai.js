/**
 * 本地 mock OpenAI 兼容网关（仅测试用）：
 * - /v1/chat/completions：支持 stream 与非 stream；含 doccn token 的首轮流式请求返回 lark_doc_get 工具调用，
 *   工具结果回来后流式输出正文（用于 pi 模式全流程）
 * - /v1/responses：支持 stream（response.output_text.delta 事件）与非 stream
 * - /v1/models：模型列表
 */
const http = require("http");
const PORT = Number(process.env.MOCK_PORT) || 9191;

const TEXT_PIECES = ["已读取文档《上线方案》。", "**里程碑**：阶段一已完成，", "阶段二进行中，预计下周评审。"];

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function chunk(model, delta, finish) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: nowSec(),
    model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  };
}

function streamText(res, model) {
  res.write(`data: ${JSON.stringify(chunk(model, { role: "assistant", content: "" }))}\n\n`);
  let i = 0;
  const timer = setInterval(() => {
    if (i < TEXT_PIECES.length) {
      res.write(`data: ${JSON.stringify(chunk(model, { content: TEXT_PIECES[i++] }))}\n\n`);
    } else {
      clearInterval(timer);
      res.write(`data: ${JSON.stringify(chunk(model, {}, "stop"))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, 30);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let b = {};
    try {
      b = body ? JSON.parse(body) : {};
    } catch {
      /* 忽略 */
    }
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "missing bearer" } }));
    }
    const model = b.model || "mock-model";

    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-model" }, { id: "mock-mini" }] }));
    }

    if (req.url === "/v1/chat/completions") {
      if (!b.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: TEXT_PIECES.join("") } }] }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const userText = (b.messages || [])
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((c) => (c && c.text) || "").join(" ")
              : ""
        )
        .join(" ");
      const token = (userText.match(/doccn[A-Za-z0-9]+/) || [])[0];
      const lastRole = (b.messages || []).length ? b.messages[b.messages.length - 1].role : "user";

      if (token && Array.isArray(b.tools) && b.tools.length && lastRole !== "tool") {
        // 第一阶段：要求调用工具
        send(
          chunk(model, {
            tool_calls: [
              {
                index: 0,
                id: "call_mock_1",
                type: "function",
                function: { name: "lark_doc_get", arguments: JSON.stringify({ doc: token }) },
              },
            ],
          }, "tool_calls")
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (lastRole === "tool") {
        // 第二阶段：带着工具结果流式输出正文
        send(chunk(model, { role: "assistant", content: "" }));
        let i = 0;
        const timer = setInterval(() => {
          if (i < TEXT_PIECES.length) {
            send(chunk(model, { content: TEXT_PIECES[i++] }));
          } else {
            clearInterval(timer);
            send(chunk(model, {}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }, 30);
        return;
      }
      return streamText(res, model);
    }

    if (req.url === "/v1/responses") {
      if (!b.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: TEXT_PIECES.join("") }] }] })
        );
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let i = 0;
      const timer = setInterval(() => {
        if (i < TEXT_PIECES.length) {
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: TEXT_PIECES[i++] })}\n\n`);
        } else {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: {} } })}\n\n`
          );
          res.end();
        }
      }, 30);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock openai on :${PORT}`));
