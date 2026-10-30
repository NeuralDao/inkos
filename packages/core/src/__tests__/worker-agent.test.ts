import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { runWorkerAgent, runWorkerAgentTool } from "../agent/worker-agent.js";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { createLLMClient } from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";

describe("pipeline model metadata cache", () => {
  it.each([false, true])("isolates same-endpoint aliases in either order (%s)", reverse => {
    const base = createLLMClient(LLMConfigSchema.parse({ provider: "custom", baseUrl: "https://router.example/v1", model: "base", apiKey: "fixture", contextWindow: 65536, maxTokens: 4096 }));
    const pipeline = new PipelineRunner({ projectRoot: "", client: base, model: "base", modelOverrides: {
      writer: { model: "small", baseUrl: "https://router.example/v1", contextWindow: 4096, maxTokens: 512 },
      auditor: { model: "large", baseUrl: "https://router.example/v1", contextWindow: 32768, maxTokens: 2048 },
      reviser: "other-alias",
    } });
    for (const role of reverse ? ["auditor", "writer"] : ["writer", "auditor"]) pipeline.createAgentContext(role);
    const writer = pipeline.createAgentContext("writer"), auditor = pipeline.createAgentContext("auditor");
    expect(writer.client._piModel).toMatchObject({ id: "small", contextWindow: 4096, maxTokens: 512 });
    expect(auditor.client._piModel).toMatchObject({ id: "large", contextWindow: 32768, maxTokens: 2048 });
    expect(pipeline.createAgentContext("writer").client).toBe(writer.client);
    expect(pipeline.createAgentContext("auditor").client).toBe(auditor.client);
    expect(pipeline.createAgentContext("reviser").client._piModel).toMatchObject({ id: "other-alias", contextWindow: 128000 });
    expect(pipeline.createAgentContext("unconfigured").client).toBe(base);
  });
});

const chatCompletionMock = vi.hoisted(() => vi.fn());
const guardedPiStreamMock = vi.hoisted(() => vi.fn());
const guardedPiNonStreamingMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../llm/provider.js")>(),
  chatCompletion: chatCompletionMock,
}));

vi.mock("../agent/pi-stream.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/pi-stream.js")>("../agent/pi-stream.js");
  return {
    ...actual,
    guardedPiStream: guardedPiStreamMock,
    guardedPiNonStreaming: guardedPiNonStreamingMock,
  };
});

function client(): AgentContext["client"] {
  return {
    provider: "openai",
    service: "kkaiapi",
    apiFormat: "chat",
    stream: true,
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
      thinkingBudget: 0,
      extra: {},
    },
    _piModel: {
      id: "deepseek-v4-flash",
      name: "deepseek-v4-flash",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.kkaiapi.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_768,
    },
  };
}

class TwoStepWorker extends BaseAgent {
  get name(): string { return "two-step"; }

  async run(): Promise<void> {
    await this.chat([{ role: "user", content: "第一步" }]);
    await this.chat([{ role: "user", content: "第二步" }]);
  }
}

describe("Pi worker harness", () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
    guardedPiStreamMock.mockReset();
    guardedPiNonStreamingMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs worker messages through the InkOS provider boundary", async () => {
    chatCompletionMock.mockResolvedValue({
      content: "完成",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });

    const result = await runWorkerAgent(client(), "deepseek-v4-pro", [
      { role: "system", content: "你是审稿员" },
      { role: "user", content: "检查第一章" },
    ], { temperature: 0.2, maxTokens: 8000 });

    expect(result).toEqual({
      content: "完成",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    expect(chatCompletionMock.mock.calls[0]?.[1]).toBe("deepseek-v4-pro");
    expect(chatCompletionMock.mock.calls[0]?.[2]).toEqual([
      { role: "system", content: "你是审稿员" },
      { role: "user", content: "检查第一章" },
    ]);
    expect(chatCompletionMock.mock.calls[0]?.[3]).toMatchObject({
      temperature: 0.2,
      maxTokens: 8000,
    });
  });

  it("preserves provider failures instead of turning them into successful prose", async () => {
    chatCompletionMock.mockRejectedValue(new Error("upstream unavailable"));

    await expect(runWorkerAgent(client(), "deepseek-v4-flash", [
      { role: "user", content: "写作" },
    ])).rejects.toThrow("upstream unavailable");
  });

  it("keeps provider defaults implicit and tolerates missing usage telemetry", async () => {
    chatCompletionMock.mockResolvedValue({ content: "完成" });

    const result = await runWorkerAgent(client(), "deepseek-v4-flash", [
      { role: "user", content: "写作" },
    ]);

    expect(result).toEqual({
      content: "完成",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(chatCompletionMock.mock.calls[0]?.[3]).not.toHaveProperty("maxTokens");
    expect(chatCompletionMock.mock.calls[0]?.[3]).not.toHaveProperty("temperature");
  });

  it("aborts the current worker and never starts the next serial step", async () => {
    const controller = new AbortController();
    chatCompletionMock.mockImplementationOnce(async (
      _client,
      _model,
      _messages,
      options: { signal?: AbortSignal },
    ) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const worker = new TwoStepWorker({
      client: client(),
      model: "deepseek-v4-flash",
      projectRoot: "/tmp/inkos-worker-test",
      signal: controller.signal,
    });

    const running = worker.run();
    await vi.waitFor(() => expect(chatCompletionMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("user stopped", "AbortError"));

    await expect(running).rejects.toThrow("user stopped");
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it("submits host-consumed state through one typed Pi tool call", async () => {
    const { createAssistantMessageEventStream } = await import("@mariozechner/pi-ai");
    guardedPiStreamMock.mockImplementation((model: AgentContext["client"]["_piModel"]) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: "state-1",
          name: "submit_state",
          arguments: { label: "母亲", status: "等待退烧药" },
        }],
        api: model?.api ?? "openai-completions",
        provider: model?.provider ?? "openai",
        model: model?.id ?? "deepseek-v4-flash",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse" as const,
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
      return stream;
    });

    const result = await runWorkerAgentTool(
      client(),
      "deepseek-v4-flash",
      [{ role: "user", content: "登记当前角色状态" }],
      {
        name: "submit_state",
        label: "提交状态",
        description: "提交角色状态。",
        parameters: Type.Object({
          label: Type.String(),
          status: Type.String(),
        }),
      },
    );

    expect(result).toEqual({ label: "母亲", status: "等待退烧药" });
    expect(guardedPiStreamMock).toHaveBeenCalledTimes(1);
    expect(guardedPiStreamMock.mock.calls[0]?.[2]).toMatchObject({
      toolChoice: "required",
    });
  });

  it.each([
    { counts: [{ input: 10, output: 4, totalTokens: 14 }], expected: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } },
    { counts: [{ input: 10, output: 4, totalTokens: 14 }, { input: 15, output: 5, totalTokens: 20 }], expected: { promptTokens: 25, completionTokens: 9, totalTokens: 34 } },
    { counts: [{ input: 3, output: 1, totalTokens: 4 }, { input: 5, output: 2, totalTokens: 7 }, { input: 7, output: 3, totalTokens: 10 }], expected: { promptTokens: 15, completionTokens: 6, totalTokens: 21 } },
    { counts: [undefined, { input: 0, output: 0, totalTokens: 0 }, { input: 7, output: 3, totalTokens: 10 }], expected: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
    { counts: [undefined], expected: undefined },
    { counts: [{ input: 0, output: 0, totalTokens: 0 }], expected: undefined },
  ])("reports usage for $counts.length completed response(s)", async ({ counts, expected }) => {
    const { createAssistantMessageEventStream } = await import("@mariozechner/pi-ai");
    let turn = 0;
    guardedPiStreamMock.mockImplementation((model: NonNullable<AgentContext["client"]["_piModel"]>) => {
      const index = turn++;
      if (index >= counts.length) throw new Error("Unexpected extra model request");
      const usage = counts[index];
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: `call-${index}`, name: "submit_result", arguments: { value: index } }],
        api: model.api, provider: model.provider, model: model.id,
        usage: usage ? { ...usage, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : undefined as never,
        stopReason: "toolUse" as const, timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
      return stream;
    });
    const onUsage = vi.fn();
    const result = await runWorkerAgentTool(client(), "deepseek-v4-flash", [
      { role: "assistant", content: "Previous assistant context." },
      { role: "user", content: "Submit the result." },
    ], {
      name: "submit_result", label: "Result", description: "Submit result", parameters: Type.Object({ value: Type.Number() }),
      validate: value => { if (value.value !== counts.length - 1) throw new Error("Correct the result"); return value; },
    }, { onUsage });
    expect(result).toEqual({ value: counts.length - 1 });
    expect(guardedPiStreamMock).toHaveBeenCalledTimes(counts.length);
    if (expected) expect(onUsage).toHaveBeenCalledExactlyOnceWith(expected);
    else expect(onUsage).not.toHaveBeenCalled();
  });

  it("honors non-streaming transport for structured worker submissions", async () => {
    const { createAssistantMessageEventStream } = await import("@mariozechner/pi-ai");
    guardedPiNonStreamingMock.mockImplementation((model: AgentContext["client"]["_piModel"]) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: "state-2",
          name: "submit_state",
          arguments: { label: "灯塔", status: "亮灯", value: "0" },
        }],
        api: model?.api ?? "openai-completions",
        provider: model?.provider ?? "openai",
        model: model?.id ?? "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse" as const,
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
      return stream;
    });
    const nonStreamingClient = { ...client(), stream: false };

    const result = await runWorkerAgentTool(
      nonStreamingClient,
      "test-model",
      [{ role: "user", content: "登记灯塔" }],
      {
        name: "submit_state",
        label: "提交状态",
        description: "提交状态。",
        parameters: Type.Object({ label: Type.String(), status: Type.String(), value: Type.Union([Type.Number(), Type.String(), Type.Boolean()]) }),
      },
    );

    expect(result).toEqual({ label: "灯塔", status: "亮灯", value: "0" });
    expect(guardedPiNonStreamingMock).toHaveBeenCalledTimes(1);
    expect(guardedPiNonStreamingMock.mock.calls[0]?.[2]).toMatchObject({
      toolChoice: "required",
    });
  });
});
