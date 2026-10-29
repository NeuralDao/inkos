import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBookFoundationTool, executeExplicitCapabilityTool, type AgentSkill } from "@actalk/inkos-core";
import { createStudioServer } from "./server.js";

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  const longWritingSkill: AgentSkill = {
    id: "inkos-long-writing",
    name: "Long writing fixture",
    description: "Required long-form skill for the book creation API fixture.",
    body: "Test fixture guidance.",
    source: "builtin",
  };
  return {
    ...actual,
    loadProjectConfig: vi.fn(async () => ({ language: "zh", llm: { model: "unused" } })),
    createLLMClient: vi.fn(() => ({})),
    loadAvailableAgentSkills: vi.fn(async () => ({ skills: [longWritingSkill] })),
    createBookFoundationTool: vi.fn(actual.createBookFoundationTool),
    executeExplicitCapabilityTool: vi.fn(async () => ({ data: {} })),
  };
});
const roots: string[] = [];
async function server() {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-narrative-"));
  roots.push(root);
  return { root, app: createStudioServer({} as never, root) };
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const request = (languages: Record<string, unknown>) => ({
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Тихий город", genre: "mystery", ...languages }),
});

describe("Studio book creation language API", () => {
  it("passes Russian narrative and operational English through API params and action payload", async () => {
    const { app } = await server();
    const response = await app.request("http://localhost/api/v1/books/create", request({ narrativeLanguage: "ru" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "creating", bookId: "тихий-город" });
    expect(executeExplicitCapabilityTool).toHaveBeenCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({ language: "en", narrativeLanguage: "ru" }),
    }));
    expect(createBookFoundationTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      language: "en", actionPayload: { createBook: expect.objectContaining({ language: "en", narrativeLanguage: "ru" }) },
    }));
  });
  it.each([
    { language: "zh", narrativeLanguage: "ru" }, { language: "ru" }, { narrativeLanguage: "unsupported" },
  ])("returns 400 without new files or production for %j", async (languages) => {
    const { root, app } = await server();
    const before = await readdir(root, { recursive: true });
    const response = await app.request("http://localhost/api/v1/books/create", request(languages));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(await readdir(root, { recursive: true })).toEqual(before);
    expect(createBookFoundationTool).not.toHaveBeenCalled();
    expect(executeExplicitCapabilityTool).not.toHaveBeenCalled();
  });
});
