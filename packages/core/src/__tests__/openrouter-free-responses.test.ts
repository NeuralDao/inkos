import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { guardedPiStream } from "../agent/pi-stream.js";
import { createLLMClient } from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";

const fakeStreamSimple = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: (...args: unknown[]) => fakeStreamSimple(...args),
  };
});

function assistant(model: Model<Api>, withTool: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: withTool
      ? [{ type: "toolCall", id: "call-1", name: "submit_g1", arguments: { ok: true } }]
      : [{ type: "text", text: "I did not call the required tool." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 12,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: withTool ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

const context: Context = {
  messages: [{ role: "user", content: "Synthetic structured G1 request.", timestamp: 1 }],
  tools: [{ name: "submit_g1", description: "Submit a synthetic result.", parameters: Type.Object({ ok: Type.Boolean() }) }],
};

// Pi's SimpleStreamOptions does not declare InkOS's toolChoice extension.
// A typed variable preserves the runtime option without an excess-property error.
const requiredToolOptions: SimpleStreamOptions & { readonly toolChoice: "required" } = {
  toolChoice: "required",
  maxTokens: 256,
};

function freeResponsesModel(): Model<Api> {
  const client = createLLMClient(LLMConfigSchema.parse({
    provider: "openai",
    service: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    apiKey: "fixture",
    stream: true,
  }));
  return client._piModel!;
}

describe("OpenRouter free: offline Responses structured boundary", () => {
  afterEach(() => {
    fakeStreamSimple.mockReset();
  });

  it("keeps Responses API and requires a tool in the outgoing Pi payload", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    fakeStreamSimple.mockImplementation((model: Model<Api>, _context: Context, options: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const payload = await options.onPayload?.({ model: model.id, stream: true }, model);
        outbound.push(payload as Record<string, unknown>);
        const reply = assistant(model, true);
        stream.push({ type: "start", partial: reply });
        stream.push({ type: "done", reason: "toolUse", message: reply });
        stream.end();
      })().catch((error: unknown) => {
        const failure = assistant(model, false);
        failure.stopReason = "error";
        failure.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: failure });
        stream.end();
      });
      return stream;
    });

    const model = freeResponsesModel();
    expect(model.api).toBe("openai-responses");
    const response = await guardedPiStream(model, context, requiredToolOptions, 0).result();

    expect(fakeStreamSimple).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ model: "openrouter/free", stream: true, tool_choice: "required" });
    expect(response.stopReason).toBe("toolUse");
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "toolCall", name: "submit_g1", arguments: { ok: true } }),
    ]));
  });

  it("refuses an oversized free-route context before the SDK call", () => {
    const model = { ...freeResponsesModel(), contextWindow: 1024 };
    const oversized: Context = {
      ...context,
      messages: [{ role: "user", content: "Synthetic oversized input. ".repeat(2000), timestamp: 1 }],
    };
    expect(() => guardedPiStream(model, oversized, requiredToolOptions, 0))
      .toThrow(/InkOS context window guard/);
    expect(fakeStreamSimple).not.toHaveBeenCalled();
  });

  it("does not accept a tool call cut off by the upstream output limit", async () => {
    fakeStreamSimple.mockImplementation((model: Model<Api>) => {
      const stream = createAssistantMessageEventStream();
      const reply = assistant(model, true);
      reply.stopReason = "length";
      queueMicrotask(() => {
        stream.push({ type: "start", partial: reply });
        stream.push({ type: "done", reason: "length", message: reply });
        stream.end();
      });
      return stream;
    });
    const response = await guardedPiStream(freeResponsesModel(), context, requiredToolOptions, 0).result();
    expect(response.stopReason).toBe("length");
    expect(response.content.some(part => part.type === "toolCall")).toBe(false);
    expect(fakeStreamSimple).toHaveBeenCalledTimes(1);
  });

  it("rejects a plain-text answer when a structured tool is mandatory", async () => {
    fakeStreamSimple.mockImplementation((model: Model<Api>) => {
      const stream = createAssistantMessageEventStream();
      const reply = assistant(model, false);
      queueMicrotask(() => {
        stream.push({ type: "start", partial: reply });
        stream.push({ type: "done", reason: "stop", message: reply });
        stream.end();
      });
      return stream;
    });

    const response = await guardedPiStream(freeResponsesModel(), context, requiredToolOptions, 0).result();
    expect(fakeStreamSimple).toHaveBeenCalledTimes(1);
    expect(response.stopReason).toBe("error");
    expect(response.errorMessage).toMatch(/required tool call/);
  });
});
