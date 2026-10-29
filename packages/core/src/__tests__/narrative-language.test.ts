import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookConfigSchema } from "../models/book.js";
import { resolveBookCreationLanguages, resolveNarrativeLanguage } from "../utils/book-language.js";
import { CreateBookActionPayloadSchema } from "../interaction/action-envelope.js";
import { createBookFoundationTool } from "../harness/tools/longform-production.js";
import { createProfileWorkTools } from "../harness/tools/work-creation.js";
import type { CapabilityRegistry } from "../harness/capability-registry.js";
import { loadWorkManifest } from "../harness/work-store.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), "inkos-narrative-language-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const base = {
  id: "city", title: "Тихий город", platform: "other", genre: "mystery", status: "outlining",
  targetChapters: 10, chapterWordCount: 2000,
  createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z",
};

describe("book narrative language contract", () => {
  it("defaults Russian narrative to operational English even in a Chinese project", () => {
    expect(resolveBookCreationLanguages({ narrativeLanguage: "ru" }, "zh"))
      .toEqual({ language: "en", narrativeLanguage: "ru" });
    expect(BookConfigSchema.parse({ ...base, narrativeLanguage: "ru" }).language).toBe("en");
  });
  it.each(["en", "zh"] as const)("keeps old %s books unchanged", (language) => {
    const book = BookConfigSchema.parse({ ...base, language });
    expect(book).not.toHaveProperty("narrativeLanguage");
    expect(resolveNarrativeLanguage(book)).toBe(language);
  });
  it.each([
    { language: "zh", narrativeLanguage: "ru" },
    { language: "ru" }, { language: "invalid" }, { narrativeLanguage: "invalid" },
  ])("rejects unsupported/conflicting inputs %j", (input) => {
    expect(() => resolveBookCreationLanguages(input)).toThrow();
    expect(() => BookConfigSchema.parse({ ...base, language: "en", ...input })).toThrow();
    expect(() => CreateBookActionPayloadSchema.parse(input)).toThrow();
  });
  it("preserves the field in the confirmation action payload", () => {
    expect(CreateBookActionPayloadSchema.parse({ title: "Тихий город", narrativeLanguage: "ru" }))
      .toEqual({ title: "Тихий город", narrativeLanguage: "ru" });
  });
  it("persists and reads the contract in book.json and Work metadata", async () => {
    const root = await project();
    const runner = new PipelineRunner({ client: {} as never, model: "unused", projectRoot: root });
    const book = BookConfigSchema.parse({ ...base, language: "en", narrativeLanguage: "ru" });
    await runner.prepareDraftBook(book);
    expect(await new StateManager(root).loadBookConfig(book.id)).toEqual(book);
    expect((await loadWorkManifest(root, book.id)).metadata.narrativeLanguage).toBe("ru");
  });
  it("rejects invalid direct Core initialization before writing files or generating", async () => {
    const root = await project();
    const runner = new PipelineRunner({ client: {} as never, model: "unused", projectRoot: root });
    const invalid = { ...base, language: "zh", narrativeLanguage: "ru" } as Parameters<typeof runner.initBook>[0];
    await expect(runner.initBook(invalid)).rejects.toThrow("Russian narrativeLanguage");
    await expect(runner.prepareDraftBook(invalid)).rejects.toThrow("Russian narrativeLanguage");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("longform creation routing", () => {
  function pipeline() {
    const initBook = vi.fn(async () => {});
    const runWithAgentContext = vi.fn(async (_ctx: unknown, run: () => Promise<unknown>) => run());
    return { initBook, runWithAgentContext, runner: { initBook, runWithAgentContext } as unknown as PipelineRunner };
  }
  it.each(["params", "payload"] as const)("keeps Russian narrative and English operations from %s", async (source) => {
    const p = pipeline();
    const languages = { narrativeLanguage: "ru" as const };
    const tool = createBookFoundationTool(p.runner, source === "payload"
      ? { actionPayload: { createBook: { title: "Тихий город", ...languages } }, language: "zh" } : { language: "zh" });
    await tool.execute("create", { instruction: "Create a book", title: "Тихий город", ...(source === "params" ? languages : {}) });
    expect(p.initBook).toHaveBeenCalledWith(expect.objectContaining({ language: "en", narrativeLanguage: "ru" }), expect.anything());
  });
  it("rejects an explicit zh + ru action before starting the pipeline", async () => {
    const p = pipeline();
    await expect(createBookFoundationTool(p.runner).execute("create", {
      instruction: "Create", title: "City", language: "zh", narrativeLanguage: "ru",
    })).rejects.toThrow("Russian narrativeLanguage");
    expect(p.runWithAgentContext).not.toHaveBeenCalled();
    expect(p.initBook).not.toHaveBeenCalled();
  });
  it("rejects conflicting operational language across payload and params", async () => {
    const p = pipeline();
    await expect(createBookFoundationTool(p.runner, {
      actionPayload: { createBook: { title: "City", narrativeLanguage: "ru" } },
    }).execute("create", { instruction: "Create", language: "zh" })).rejects.toThrow("Russian narrativeLanguage");
    expect(p.initBook).not.toHaveBeenCalled();
  });
  it("stores the Work contract and transfers it into the initialized book", async () => {
    const root = await project();
    const registry = { forProfile: vi.fn() } as unknown as CapabilityRegistry;
    const create = createProfileWorkTools(root, registry).find(tool => tool.name === "create_work")!;
    await create.execute("work", { workId: "city", profileId: "longform-novel", title: "Тихий город", intent: "A city mystery", narrativeLanguage: "ru" });
    const work = await loadWorkManifest(root, "city");
    expect(work.language).toBe("en");
    expect(work.metadata.narrativeLanguage).toBe("ru");
    const p = pipeline();
    await createBookFoundationTool(p.runner, { activeWork: { work, projectRoot: root } })
      .execute("initialize", { instruction: "Initialize the Work" });
    expect(p.initBook).toHaveBeenCalledWith(expect.objectContaining({ language: "en", narrativeLanguage: "ru" }), expect.anything());
  });
  it.each([
    { language: "zh", narrativeLanguage: "ru" }, { language: "ru" }, { narrativeLanguage: "invalid" },
  ])("rejects invalid Work input before acquiring a lock or writing %j", async (languages) => {
    const root = await project();
    const registry = { forProfile: vi.fn() } as unknown as CapabilityRegistry;
    const create = createProfileWorkTools(root, registry).find(tool => tool.name === "create_work")!;
    await expect(create.execute("work", { workId: "city", profileId: "longform-novel", title: "City", intent: "Mystery", ...languages })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});
