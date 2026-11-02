import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "@mariozechner/pi-ai";
import { archiveWorkerResponse, markWorkerResponseArchive } from "../agent/worker-response-archive.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-response-archive-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("worker response archive", () => {
  const model: Model<Api> = {
    id: "fixture/model", name: "Fixture model", api: "openai-completions", provider: "openai",
    baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512,
  };

  it("stores the raw response and routing metadata without archiving prompts or credentials", async () => {
    const root = await makeRoot();
    const response = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "raw response" }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const, timestamp: Date.now(),
    };

    const path = await archiveWorkerResponse({
      context: { projectRoot: root, workId: "book/1", role: "auditor" }, model, response, attempt: 2,
    });
    const raw = await readFile(path, "utf8");
    const archive = JSON.parse(raw);

    expect(archive).toMatchObject({
      schemaVersion: 1, workId: "book/1", agentRole: "auditor", attempt: 2,
      model: { id: "fixture/model", provider: "openai", api: "openai-completions" },
      response: { content: [{ text: "raw response" }], usage: { output: 7 } },
      validation: { status: "received_before_processing", stages: [] },
    });
    expect(archive).not.toHaveProperty("prompt");
    expect(archive).not.toHaveProperty("apiKey");
    expect(raw).not.toContain("private prompt");
    expect(raw).not.toContain("sk-test-secret");
  });

  it("retains the original response when validation fails", async () => {
    const root = await makeRoot();
    const response = {
      role: "assistant" as const, content: [{ type: "text" as const, text: "invalid but useful output" }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const, timestamp: Date.now(),
    };
    const path = await archiveWorkerResponse({
      context: { projectRoot: root, workId: "book-2", role: "state-validator" }, model, response, attempt: 1,
    });

    await markWorkerResponseArchive(path, { stage: "schema", status: "failed", code: "WORKER_SCHEMA_INVALID" });

    const archive = JSON.parse(await readFile(path, "utf8"));
    expect(archive.response.content[0].text).toBe("invalid but useful output");
    expect(archive.validation).toEqual({ status: "checked", stages: [
      { stage: "schema", status: "failed", code: "WORKER_SCHEMA_INVALID" },
    ] });
  });
});
