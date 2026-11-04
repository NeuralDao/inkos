import { createServer } from "node:http";
const server = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const name = JSON.parse(body || "{}").tool_choice ? "submit_smoke" : "submit_smoke";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "stub", object: "chat.completion", model: "stub",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "call_stub", type: "function", function: { name, arguments: JSON.stringify({ ok: true, note: "dry run" }) } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
server.listen(45999, "127.0.0.1", () => console.log("stub on 45999"));
