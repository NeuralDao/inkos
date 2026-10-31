import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { chatCompletion, createLLMClient, normalizeOpenRouterReasoningPayload } from "../llm/provider.js";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import { LLMConfigSchema } from "../models/project.js";

type ApiFormat = "chat" | "responses";

function createOpenRouterClient(
  apiFormat: ApiFormat,
  stream: boolean,
  extra: Record<string, unknown> = {},
) {
  const client = createLLMClient(LLMConfigSchema.parse({
    provider: "openai",
    service: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    apiKey: "fixture-key",
    apiFormat,
    stream,
    maxTokens: 64,
    thinkingBudget: 1,
    extra,
  }));
  // OpenRouter's preset selects Responses regardless of apiFormat. Construct
  // the Pi model explicitly to exercise its Chat Completions adapter as well.
  return apiFormat === "chat"
    ? { ...client, _piModel: { ...client._piModel!, api: "openai-completions" as const } }
    : client;
}

function captureRejectedOpenRouterRequests() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : undefined;
    const bodyText = typeof init?.body === "string"
      ? init.body
      : request
        ? await request.text()
        : "";
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      body: bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {},
    });
    return new Response(JSON.stringify({
      error: { message: "Fixture rejection; no upstream request is made." },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter implicit reasoning disable", () => {
  it.each([
    { apiFormat: "responses" as const, stream: true },
    { apiFormat: "responses" as const, stream: false },
    { apiFormat: "chat" as const, stream: true },
    { apiFormat: "chat" as const, stream: false },
  ])("omits SDK-generated effort=none from direct text requests ($apiFormat, stream=$stream)", async ({ apiFormat, stream }) => {
    const requests = captureRejectedOpenRouterRequests();
    const client = createOpenRouterClient(apiFormat, stream);
    expect(client._piModel?.api).toBe(apiFormat === "chat" ? "openai-completions" : "openai-responses");

    await expect(chatCompletion(
      client,
      "openrouter/free",
      [{ role: "user", content: "Fixture request." }],
      { retry: false },
    )).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).not.toHaveProperty("reasoning");
  });

  it.each(["responses", "chat"] as const)(
    "omits SDK-generated effort=none from structured workers (%s)",
    async apiFormat => {
      const requests = captureRejectedOpenRouterRequests();
      const client = createOpenRouterClient(apiFormat, true);
      expect(client._piModel?.api).toBe(apiFormat === "chat" ? "openai-completions" : "openai-responses");
      const tool = {
        name: "submit_fixture",
        label: "Fixture",
        description: "Submit a fixture result.",
        parameters: Type.Object({ ok: Type.Boolean() }),
      };

      await expect(runWorkerAgentTool(
        client,
        "openrouter/free",
        [{ role: "user", content: "Submit the fixture result." }],
        tool,
      )).rejects.toThrow();

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body).not.toHaveProperty("reasoning");
    },
  );

  it("preserves explicit provider reasoning in direct text requests", async () => {
    const requests = captureRejectedOpenRouterRequests();
    const client = createOpenRouterClient("responses", false, {
      reasoning: { effort: "high" },
    });

    await expect(chatCompletion(
      client,
      "openrouter/free",
      [{ role: "user", content: "Fixture request." }],
      { retry: false },
    )).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.reasoning).toEqual({ effort: "high" });
  });

  it("preserves explicit provider reasoning in structured workers", async () => {
    const requests = captureRejectedOpenRouterRequests();
    const client = createOpenRouterClient("responses", true, {
      reasoning: { effort: "high" },
    });
    const tool = {
      name: "submit_fixture",
      label: "Fixture",
      description: "Submit a fixture result.",
      parameters: Type.Object({ ok: Type.Boolean() }),
    };

    await expect(runWorkerAgentTool(
      client,
      "openrouter/free",
      [{ role: "user", content: "Submit the fixture result." }],
      tool,
    )).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.reasoning).toEqual({ effort: "high" });
  });

  it("removes only the implicit none value without mutating the SDK payload", () => {
    const payload = { reasoning: { effort: "none" }, model: "fixture" };
    const openRouterModel = {
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as const;

    expect(normalizeOpenRouterReasoningPayload(payload, openRouterModel)).toEqual({
      model: "fixture",
    });
    expect(payload.reasoning).toEqual({ effort: "none" });
    const extended = { reasoning: { effort: "none", exclude: true }, model: "fixture" };
    expect(normalizeOpenRouterReasoningPayload(extended, openRouterModel)).toBe(extended);
  });

  it("does not rewrite explicit reasoning disable or non-OpenRouter payloads", () => {
    const payload = { reasoning: { effort: "none" }, model: "fixture" };
    const openRouterModel = {
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
    } as const;
    const otherModel = {
      api: "openai-responses",
      baseUrl: "https://gateway.example/v1",
    } as const;

    expect(normalizeOpenRouterReasoningPayload(payload, openRouterModel, {
      explicitReasoning: { effort: "none" },
    })).toEqual(payload);
    expect(normalizeOpenRouterReasoningPayload(payload, openRouterModel, {
      reasoningRequested: true,
    })).toBe(payload);
    expect(normalizeOpenRouterReasoningPayload(payload, otherModel)).toBe(payload);
  });
});
