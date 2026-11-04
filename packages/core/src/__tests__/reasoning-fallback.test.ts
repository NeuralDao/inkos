import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Type } from "@mariozechner/pi-ai";
import { createLLMClient } from "../llm/provider.js";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import { stripReasoningFields } from "../agent/pi-stream.js";
import { isReasoningRejection } from "../llm/reasoning.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const tool = {
  name: "submit_value",
  label: "Submit",
  description: "Submit a value",
  parameters: Type.Object({ value: Type.Number() }),
};

async function serve(handler: (body: Record<string, unknown>, index: number) => { status: number; payload: unknown }) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    bodies.push(body);
    const { status, payload } = handler(body, bodies.length - 1);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { bodies, baseUrl: `http://127.0.0.1:${port}/v1` };
}

const reasoningRejected = {
  status: 400,
  payload: { error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 } },
};

const validToolCall = {
  status: 200,
  payload: {
    id: "fixture", object: "chat.completion", model: "fixture",
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "submit_value", arguments: '{"value":7}' } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
};

function client(baseUrl: string, reasoning: "low" | undefined) {
  return createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture",
    baseUrl, apiKey: "fixture", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0,
    ...(reasoning ? { reasoning } : {}) });
}

describe("reasoning 400 fallback", () => {
  it("retries once without any reasoning field and still returns the structured result", async () => {
    const { bodies, baseUrl } = await serve((_body, index) => index === 0 ? reasoningRejected : validToolCall);
    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await withExecutionEvidence((type, payload) => events.push({ type, payload }), async () =>
      runWorkerAgentTool(client(baseUrl, "low"), "fixture", [{ role: "user", content: "Submit 7" }], tool, { maxTokens: 128 }));

    expect(result).toEqual({ value: 7 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.reasoning ?? bodies[0]?.reasoning_effort).toBeDefined();
    expect(bodies[1]).not.toHaveProperty("reasoning");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).not.toHaveProperty("thinking");
    expect(events.filter(event => event.type === "model-reasoning-rejected")).toHaveLength(1);
  }, 20_000);

  it("does not retry a 400 that has nothing to do with reasoning", async () => {
    const { bodies, baseUrl } = await serve(() => ({
      status: 400,
      payload: { error: { message: "max_tokens is too large for this model", code: 400 } },
    }));
    await expect(runWorkerAgentTool(client(baseUrl, "low"), "fixture", [{ role: "user", content: "Submit 7" }], tool, { maxTokens: 128 }))
      .rejects.toThrow();
    expect(bodies).toHaveLength(1);
  }, 20_000);

  it("gives up after one fallback attempt and reports that it was attempted", async () => {
    const { bodies, baseUrl } = await serve(() => reasoningRejected);
    const error = await runWorkerAgentTool(client(baseUrl, "low"), "fixture", [{ role: "user", content: "Submit 7" }], tool, { maxTokens: 128 })
      .then(() => undefined, (caught: unknown) => caught as Record<string, unknown>);
    expect(error).toBeTruthy();
    expect(error?.reasoningRetryAttempted).toBe(true);
    expect(bodies).toHaveLength(2);
  }, 20_000);
});

describe("reasoning rejection classification and stripping", () => {
  it("recognises structured and textual 400 reasoning rejections only", () => {
    expect(isReasoningRejection({ errorMessage: "400 Reasoning is mandatory for this endpoint and cannot be disabled." })).toBe(true);
    expect(isReasoningRejection({ error: { status: 400, message: "thinking is not supported for this model" } })).toBe(true);
    expect(isReasoningRejection({ errorMessage: "400 max_tokens is too large" })).toBe(false);
    expect(isReasoningRejection({ errorMessage: "Reasoning is mandatory" })).toBe(false);
    expect(isReasoningRejection(undefined)).toBe(false);
  });

  it("strips levels as well as disables", () => {
    expect(stripReasoningFields({ model: "m", reasoning: { effort: "low" }, reasoning_effort: "high", thinking: { type: "enabled" }, enable_thinking: true }))
      .toEqual({ model: "m" });
  });
});
