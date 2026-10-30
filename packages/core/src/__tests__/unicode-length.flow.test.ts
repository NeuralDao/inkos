import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import type { LLMClient, LLMMessage } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import { ChapterMetaSchema } from "../models/chapter.js";
import { WriterAgent } from "../agents/writer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { ComposerAgent } from "../agents/composer.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { reviewChapterDraft } from "../pipeline/chapter-review.js";
import { StateManager } from "../state/manager.js";
import { syncChapterWordCounts } from "../state/chapter-word-sync.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import { createLLMClient } from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";
import type { AgentContext } from "../agents/base.js";

// Replace only model transport/decisions. Real Writer, settlement, Runner,
// review counts, persistence, schemas, telemetry and word-sync remain active.
vi.mock("../agent/worker-agent.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent/worker-agent.js")>(),
  runWorkerAgentTool: vi.fn(),
}));

const prose = "Ёж увидел Apollo-1. NASA ждала у старой пристани."; // 8 words
const revised = "Ёж увидел Apollo-1. NASA терпеливо ждала у старой пристани."; // 9
const roots: string[] = [];
const calls: Array<{ name: string; messages: ReadonlyArray<LLMMessage> }> = [];
const client = { defaults: { maxTokens: 16384 } } as unknown as LLMClient;

beforeEach(() => {
  calls.length = 0;
  vi.mocked(runWorkerAgentTool).mockImplementation(async (_client, _model, messages, tool, options) => {
    calls.push({ name: tool.name, messages });
    const reply = tool.name === "submit_chapter_draft" ? { title: "Пристань", content: prose }
      : tool.name === "submit_revised_chapter" ? { revisedContent: revised }
      : tool.name === "submit_runtime_state_delta" ? {
        postSettlement: "The visitor waits at the pier.",
        factOps: { upsert: [], expire: [] },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { title: "Пристань", characters: "visitor", events: "Arrival", stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "arrival" },
      } : undefined;
    if (!reply) throw new Error(`Unexpected model operation: ${tool.name}`);
    expect(Value.Check(tool.parameters, reply)).toBe(true);
    options?.onUsage?.({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return (tool.validate ? await tool.validate(reply as never) : reply) as never;
  });
  vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockResolvedValue({ chapter: 1, selectedContext: [] });
  vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({ observations: [], summary: "Reviewed." });
  vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ consistent: true, reconciliationRequired: false, observations: [] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("inkos-unicode-length-")) throw new Error("Unexpected fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-unicode-length-"));
  roots.push(root);
  const state = new StateManager(root);
  const book: BookConfig = {
    id: "city", title: "Город", genre: "general", platform: "other", status: "active", language: "en", narrativeLanguage: "ru",
    chapterWordCount: 9, minChapterLength: 8, maxChapterLength: 10, targetChapters: 2,
    createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  };
  await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language: "en" }));
  await state.saveBookConfig(book.id, book);
  const bookDir = state.bookDir(book.id);
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  for (const [path, text] of Object.entries({
    "outline/story_frame.md": "A visitor arrives at the pier.", "outline/volume_map.md": "Two scenes.",
    "book_rules.md": "# Rules\nPreserve facts.", "book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }),
  })) await writeFile(join(bookDir, "story", path), text);
  await createInitialRuntimeState({ bookDir, language: "en" });
  await state.saveChapterIndex(book.id, []);
  await state.snapshotState(book.id, 0);
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  await savePersistedPlan(bookDir, {
    intent: { chapter: 1, goal: "Arrive at the pier." },
    memo: { chapter: 1, goal: "Arrive at the pier.", body: "The visitor arrives.", threadRefs: [] },
    intentMarkdown: "Arrive at the pier.", runtimePath: "runtime/chapter-1.intent.md", plannerInputs: [],
  });
  return { root, state, book, bookDir, runner: new PipelineRunner({ projectRoot: root, client, model: "unused" }) };
}

function expectEnglishAudits() {
  const audits = vi.mocked(ContinuityAuditor.prototype.auditChapter).mock.calls;
  expect(audits.length).toBeGreaterThan(0);
  for (const call of audits) expect(call[4]?.language).toBe("en");
}

describe("Russian longform length routes", () => {
  it.each([false, true])("routes StateValidator consistently through write, revise and resync (override=%s)", async enabled => {
    const { root, book } = await fixture();
    const base = createLLMClient(LLMConfigSchema.parse({ provider: "custom", baseUrl: "https://router.example/v1", model: "base-model", apiKey: "fixture" }));
    const runner = new PipelineRunner({ projectRoot: root, client: base, model: "base-model",
      ...(enabled ? { modelOverrides: { "state-validator": { model: "validator-model", contextWindow: 8192, maxTokens: 1024 } } } : {}),
    });
    const expected = runner.createAgentContext("state-validator", book.id);
    const seen: AgentContext[] = [];
    vi.mocked(StateValidatorAgent.prototype.validate).mockImplementation(async function (this: StateValidatorAgent) {
      seen.push((this as unknown as { ctx: AgentContext }).ctx);
      return { consistent: true, reconciliationRequired: false, observations: [] };
    });
    expect(expected.model).toBe(enabled ? "validator-model" : "base-model");
    expect(expected.client._piModel?.id).toBe(expected.model);
    expect(runner.createAgentContext("writer", book.id).client).toBe(base);
    for (const operation of [
      () => runner.writeNextChapter(book.id),
      () => runner.reviseDraft(book.id, 1, "rewrite", "Polish the prose in Russian."),
      () => runner.resyncChapterStateAndAudit(book.id, 1),
    ]) {
      seen.length = 0;
      await operation();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.model).toBe(expected.model);
      expect(seen[0]!.client).toBe(expected.client);
      expect(seen[0]!.bookId).toBe(book.id);
    }
  }, 30000);

  it("counts real Writer output and separate settlement with RU metrics and EN state", async () => {
    const { root, book, bookDir } = await fixture();
    const writer = new WriterAgent({ projectRoot: root, client, model: "unused" });
    const output = await writer.writeChapter({ book, bookDir, chapterNumber: 1,
      chapterIntent: "Arrive.", chapterMemo: { chapter: 1, goal: "Arrive.", body: "The visitor arrives.", threadRefs: [] }, contextPackage: { chapter: 1, selectedContext: [] } });
    expect(output.wordCount).toBe(8);
    const settled = await writer.settleChapterState({ book, bookDir, chapterNumber: 1, baselineChapter: 0,
      title: output.title, content: revised, chapterIntent: "Arrive.", contextPackage: { chapter: 1, selectedContext: [] } });
    expect(settled.wordCount).toBe(9);
    expect(settled.runtimeStateSnapshot.manifest.language).toBe("en");
    for (const call of calls.filter(call => call.name === "submit_runtime_state_delta")) {
      expect(call.messages.map(message => message.content).join("\n")).not.toContain("## Revision narrative language");
      expect(call.messages.map(message => message.content).join("\n")).toContain("Settlement baseline");
    }
  });

  it("persists matching generation/revision counts, telemetry and index, then word-sync is idempotent", async () => {
    const { runner, state, book, bookDir } = await fixture();
    const written = await runner.writeNextChapter(book.id);
    expect(written).toMatchObject({ wordCount: 8, lengthTelemetry: { countingMode: "ru_words", writerCount: 8, finalCount: 8 } });
    const revision = await runner.reviseDraft(book.id, 1, "rewrite", "Polish the prose in Russian.");
    expect(revision).toMatchObject({ wordCount: 9, lengthTelemetry: { countingMode: "ru_words", writerCount: 8, postReviseCount: 9, finalCount: 9 } });
    const index = await state.loadChapterIndex(book.id);
    expect(ChapterMetaSchema.parse(JSON.parse(JSON.stringify(index[0])))).toMatchObject({ wordCount: 9, lengthTelemetry: { countingMode: "ru_words", finalCount: 9 } });
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
    const save = vi.spyOn(state, "saveChapterIndex");
    expect(await syncChapterWordCounts(state, book.id)).toMatchObject({ countingMode: "ru_words", changes: [], missingChapterFiles: [] });
    expect(await syncChapterWordCounts(state, book.id)).toMatchObject({ changes: [] });
    expect(save).not.toHaveBeenCalled();
    expectEnglishAudits();
  });

  it("counts imported Russian prose and resyncs an externally edited chapter without changing its prose", async () => {
    const { runner, state, book, bookDir } = await fixture();
    await runner.importChapters({ bookId: book.id, chapters: [{ title: "Пристань", content: prose }], resumeFrom: 1 });
    expect((await state.loadChapterIndex(book.id))[0]?.wordCount).toBe(8);
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    const chapterPath = join(bookDir, "chapters", file);
    const edited = (await readFile(chapterPath, "utf8")).replace(prose, revised);
    await writeFile(chapterPath, edited);
    const result = await runner.resyncChapterStateAndAudit(book.id, 1);
    expect(result.chapter.wordCount).toBe(9);
    expect((await state.loadChapterIndex(book.id))[0]?.wordCount).toBe(9);
    expect(await readFile(chapterPath, "utf8")).toBe(edited);
    expect((await loadRuntimeStateSnapshot(bookDir)).manifest.language).toBe("en");
    expectEnglishAudits();
  });

  it("updates final telemetry on recount, skips missing chapters and does not rewrite an already synced index", async () => {
    const { state, book, bookDir } = await fixture();
    const base = { title: "Пристань", wordCount: 0, createdAt: book.createdAt, updatedAt: book.updatedAt, observations: [], provenance: "generated" as const };
    await state.saveChapterIndex(book.id, [{ ...base, number: 1, lengthTelemetry: { target: 9, countingMode: "ru_words", writerCount: 8, postReviseCount: 0, finalCount: 0, repairApplied: false } }, { ...base, number: 2, wordCount: 99 }]);
    await writeFile(join(bookDir, "chapters", "0001_pier.md"), "# Скрытый заголовок\n\n" + prose);
    const save = vi.spyOn(state, "saveChapterIndex");
    const result = await syncChapterWordCounts(state, book.id);
    expect(result).toMatchObject({ countingMode: "ru_words", missingChapterFiles: [2], changes: [{ number: 1, previousWordCount: 0, wordCount: 8 }] });
    expect((await state.loadChapterIndex(book.id))[0]).toMatchObject({ wordCount: 8, lengthTelemetry: { writerCount: 8, finalCount: 8, countingMode: "ru_words" } });
    expect((await state.loadChapterIndex(book.id))[1]?.wordCount).toBe(99);
    const once = await readFile(join(bookDir, "chapters", "index.json"), "utf8");
    expect(await syncChapterWordCounts(state, book.id)).toMatchObject({ changes: [], missingChapterFiles: [2] });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await readFile(join(bookDir, "chapters", "index.json"), "utf8")).toBe(once);
  });

  it("uses the explicit operational language for Auditor and unavailable-review messages with ru_words", async () => {
    const auditor = { auditChapter: vi.fn().mockRejectedValue(new Error("fixture unavailable")) };
    const result = await reviewChapterDraft({
      book: { genre: "general", language: "en" }, bookDir: "unused", chapterNumber: 1, output: { content: prose },
      controlInput: { contextPackage: { chapter: 1, selectedContext: [] } },
      lengthSpec: buildLengthSpec(9, "en", { narrativeLanguage: "ru", minChapterLength: 8, maxChapterLength: 10 }),
      initialUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, auditor,
      assertNotEmpty: () => {}, addUsage: left => left,
    });
    expect(result.wordCount).toBe(8);
    expect(auditor.auditChapter.mock.calls[0]?.[4]).toMatchObject({ language: "en" });
    expect(result.review.summary).toBe("Review unavailable");
    expect(result.review.observations[0]?.summary).toContain("Review observation was unavailable:");
  });

  it("repairs stale RU telemetry even when the numeric word count already matches", async () => {
    const { state, book, bookDir } = await fixture();
    await state.saveChapterIndex(book.id, [{ number: 1, title: "Пристань", wordCount: 8, createdAt: book.createdAt, updatedAt: book.updatedAt,
      observations: [], provenance: "generated", lengthTelemetry: { target: 9, countingMode: "en_words", writerCount: 2, postReviseCount: 0, finalCount: 2, repairApplied: false } }]);
    await writeFile(join(bookDir, "chapters", "0001_pier.md"), prose);
    expect(await syncChapterWordCounts(state, book.id)).toMatchObject({ countingMode: "ru_words", changes: [{ number: 1, wordCount: 8 }] });
    // Historical measurements cannot be reconstructed from the current prose.
    expect((await state.loadChapterIndex(book.id))[0]?.lengthTelemetry).toMatchObject({ countingMode: "ru_words", writerCount: 2, finalCount: 8 });
    expect(await syncChapterWordCounts(state, book.id)).toMatchObject({ changes: [] });
  });
});
