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
import { ReviserAgent } from "../agents/reviser.js";
import { PlannerAgent } from "../agents/planner.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { ComposerAgent } from "../agents/composer.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { reviewChapterDraft } from "../pipeline/chapter-review.js";
import { StateManager } from "../state/manager.js";
import { syncChapterWordCounts } from "../state/chapter-word-sync.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import { listChapterVersions, readChapterVersion } from "../state/chapter-workspace.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
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

describe("automatic longform revision", () => {
  const finding = { code: "character", summary: "Уточнить мотив", assessment: "issue" as const, scope: "structural", evidence: ["Ёж"], sourceRefs: [{ sourceId: "chapter-1", quote: "Ёж" }] };
  const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5 };
  const disposition = { findingId: "finding-1", status: "addressed" as const, explanation: "Уточнён мотив." };
  const assessment = { findingId: "finding-1", status: "resolved" as const, explanation: "Мотив понятен.", evidence: "Ёж" };

  it("accepts the Reviser's version after technical validation and preserves the original", async () => {
    const { runner, state, book, bookDir } = await fixture();
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockResolvedValue({ intent: { chapter: 1, goal: "Arrive at the pier." },
      memo: { chapter: 1, goal: "Arrive at the pier.", body: "The visitor arrives.", threadRefs: [] },
      intentMarkdown: "Arrive at the pier.", runtimePath: "runtime/chapter-1.intent.md", plannerInputs: [] });
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Найдено замечание", tokenUsage: usage });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition], tokenUsage: usage });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    const result = await runner.writeNextChapter(book.id, undefined, undefined, "Сохранить голос автора");
    expect(result.autoRevision).toMatchObject({ status: "applied", findings: [{ id: "finding-1", observation: finding }], dispositions: [disposition], assessments: [assessment] });
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]?.[4]).toBe("rework");
    const options = revise.mock.calls[0]?.[6];
    expect(options?.autoFindings).toEqual([{ id: "finding-1", observation: finding }]);
    expect(options?.contextPackage.selectedContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "story/book_rules.md", excerpt: expect.stringContaining("Preserve facts"), protection: "protected" }),
      expect.objectContaining({ source: "chapter/user-instruction", excerpt: "Сохранить голос автора", protection: "protected" }),
      expect.objectContaining({ source: "chapter/intent", excerpt: expect.stringContaining("Arrive at the pier"), protection: "protected" }),
    ]));
    expect(compare).toHaveBeenCalledTimes(1);
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision?.status).toBe("applied");
    expect(await readChapterVersion(bookDir, 1, saved.autoRevision!.originalVersionId!)).toBe(prose);
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
    expect(result.tokenUsage?.totalTokens).toBeGreaterThanOrEqual(15);
  }, 30000);

  it("runs the actual Auditor and Reviser contracts with per-agent models", async () => {
    const { root, state, book, bookDir } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockRestore();
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockResolvedValue({ intent: { chapter: 1, goal: "Arrive at the pier." },
      memo: { chapter: 1, goal: "Arrive at the pier.", body: "The visitor arrives.", threadRefs: [] },
      intentMarkdown: "Arrive at the pier.", runtimePath: "runtime/chapter-1.intent.md", plannerInputs: [] });
    const transport = vi.mocked(runWorkerAgentTool);
    const fallback = transport.getMockImplementation()!;
    const seen: Array<{ name: string; model: string; prompt: string; disableRetries?: boolean }> = [];
    transport.mockImplementation(async (...args) => {
      const [_client, model, messages, tool, options] = args;
      seen.push({ name: tool.name, model, prompt: messages.map(message => message.content).join("\n"), disableRetries: options?.disableRetries });
      const payload = tool.name === "submit_chapter_review" ? { summary: "Найдено замечание", observations: [{ code: "character", summary: "Уточнить мотив", assessment: "issue", category: "quality", scope: "structural", sourceRefs: [{ sourceId: "chapter-1", startLine: 1, endLine: 1 }] }] }
        : tool.name === "submit_revised_chapter" ? { revisedContent: revised, findingDispositions: [disposition] }
        : tool.name === "submit_revision_comparison" ? { assessments: [assessment], newIssues: [] }
        : undefined;
      if (!payload) return fallback(...args);
      expect(Value.Check(tool.parameters, payload)).toBe(true);
      options?.onUsage?.(usage);
      return (tool.validate ? await tool.validate(payload as never) : payload) as never;
    });
    const base = createLLMClient(LLMConfigSchema.parse({ provider: "openai", service: "custom", baseUrl: "https://router.example/v1", model: "base-model", apiKey: "fixture" }));
    const runner = new PipelineRunner({ projectRoot: root, client: base, model: "base-model", modelOverrides: { writer: "writer-model", auditor: "auditor-model", reviser: "reviser-model" } });
    const validatorRetryPolicies: Array<boolean | undefined> = [];
    vi.mocked(StateValidatorAgent.prototype.validate).mockImplementation(async function (this: StateValidatorAgent) {
      validatorRetryPolicies.push((this as unknown as { ctx: AgentContext }).ctx.disableRetries);
      return { consistent: true, reconciliationRequired: false, observations: [] };
    });
    const result = await withExecutionEvidence(() => {}, () => runner.writeNextChapter(book.id, undefined, undefined, "Сохранить голос автора"), undefined, undefined, "ROOT AUTHOR REQUEST: keep the narrator");
    expect(result.autoRevision?.status).toBe("applied");
    for (const [name, model] of [["submit_chapter_review", "auditor-model"], ["submit_revised_chapter", "reviser-model"], ["submit_revision_comparison", "auditor-model"]]) {
      const stages = seen.filter(call => call.name === name);
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({ model, disableRetries: true });
      expect(stages[0]!.prompt).toContain("ROOT AUTHOR REQUEST: keep the narrator");
      expect(stages[0]!.prompt).toContain("inkos-story-review");
    }
    const revision = seen.find(call => call.name === "submit_revised_chapter")!;
    expect(seen.filter(call => call.name === "submit_runtime_state_delta").at(-1)?.disableRetries).toBe(true);
    expect(validatorRetryPolicies).toEqual([true]);
    expect(revision.prompt).toContain("Сохранить голос автора");
    expect(revision.prompt).toContain("Уточнить мотив");
    expect(revision.prompt).toContain(prose);
    expect((await state.loadChapterIndex(book.id))[0]?.autoRevision?.status).toBe("applied");
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
  }, 30000);

  it("accepts the revised text and attaches new post-audit issues as notes", async () => {
    const { runner, state, book, bookDir } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Issue" });
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition] });
    vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({ assessments: [assessment], newIssues: [{ ...finding, code: "new" }], tokenUsage: usage });
    const result = await runner.writeNextChapter(book.id);
    expect(result.autoRevision).toMatchObject({ status: "applied", reason: "revised-text-accepted; post-audit-notes-attached" });
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision?.newIssues).toEqual([{ ...finding, code: "new" }]);
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
    expect(saved.observations).toContainEqual(expect.objectContaining({ code: "new" }));
  }, 30000);

  it("accepts a partial improvement and retains unresolved findings with current evidence", async () => {
    const { runner, state, book } = await fixture();
    const second = { ...finding, code: "second", summary: "Ещё одна проблема" };
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding, second], summary: "Two issues" });
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition, { findingId: "finding-2", status: "not_addressed", explanation: "Осталось." }] });
    vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({ assessments: [assessment, { findingId: "finding-2", status: "remaining", explanation: "Осталось.", evidence: "NASA" }], newIssues: [], tokenUsage: usage });
    const result = await runner.writeNextChapter(book.id);
    expect(result.autoRevision?.status).toBe("applied");
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision?.initialReview?.observations).toEqual([finding, second]);
    expect(saved.observations).toEqual([
      expect.objectContaining({ code: "character", assessment: "resolved" }),
      expect.objectContaining({ code: "second", assessment: "issue", evidence: ["NASA"], sourceRefs: [{ sourceId: "chapter-1", quote: "NASA" }] }),
    ]);
  }, 30000);

  it("keeps the draft when the candidate fails state validation", async () => {
    const { runner, state, book, bookDir } = await fixture();
    const save = vi.spyOn(WriterAgent.prototype, "saveChapter");
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Issue" });
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition] });
    vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    vi.mocked(StateValidatorAgent.prototype.validate)
      .mockResolvedValueOnce({ consistent: false, reconciliationRequired: true, observations: [] })
      .mockResolvedValueOnce({ consistent: true, reconciliationRequired: false, observations: [] });
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].content).toBe(prose);
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision).toMatchObject({ status: "candidate", reason: expect.stringContaining("technical-validation-failed") });
    expect(await readChapterVersion(bookDir, 1, saved.autoRevision!.candidateVersionId!)).toBe(revised);
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(prose);
  }, 30000);

  it("preserves both texts if final chapter persistence fails", async () => {
    const { runner, book, bookDir } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Issue" });
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition] });
    vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockRejectedValue(new Error("storage unavailable"));
    await expect(runner.writeNextChapter(book.id)).rejects.toThrow("storage unavailable");
    const versions = await listChapterVersions(bookDir, 1);
    const contents = await Promise.all(versions.map(version => readChapterVersion(bookDir, 1, version.id)));
    expect(contents).toContain(prose);
    expect(contents).toContain(revised);
  }, 30000);

  it("keeps the accepted revision and records an unavailable post-audit without retrying", async () => {
    const { runner, state, book, bookDir } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Issue" });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition] });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision")
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { tokenUsage: usage }))
      .mockResolvedValueOnce({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    const written = await runner.writeNextChapter(book.id);
    expect(written.autoRevision?.reason).toBe("revised-text-accepted; post-audit-unavailable");
    expect(compare).toHaveBeenCalledTimes(1);
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision).toMatchObject({ status: "applied", reason: "revised-text-accepted; post-audit-unavailable", usage: { postAudit: usage } });
    expect(saved.observations).toContainEqual(expect.objectContaining({ code: "POST_REVISION_AUDIT_UNAVAILABLE", assessment: "unavailable" }));
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
    const draftCalls = calls.filter(call => call.name === "submit_chapter_draft").length;
    const result = await runner.resumeChapter(book.id, 1);
    expect(result.autoRevision).toMatchObject({ status: "applied", reason: "revised-text-accepted; post-audit-unavailable" });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(calls.filter(call => call.name === "submit_chapter_draft")).toHaveLength(draftCalls);
    await runner.resumeChapter(book.id, 1);
    expect(compare).toHaveBeenCalledTimes(1);
  }, 30000);

  it("keeps an unverified post-audit finding as a warning note without blocking the chapter", async () => {
    const { runner, state, book } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Найдено замечание", tokenUsage: usage });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition], tokenUsage: usage });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({
      assessments: [], newIssues: [], tokenUsage: usage,
      warnings: [{ code: "POST_AUDIT_FINDING_UNVERIFIED", findingId: "finding-1",
        message: "Цитата не найдена в исправленном тексте", evidence: "нет такой фразы" }],
    });
    const result = await runner.writeNextChapter(book.id);
    expect(result.autoRevision?.reason).toBe("revised-text-accepted; post-audit-needs-review");
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision?.reason).toBe("revised-text-accepted; post-audit-needs-review");
    expect(saved.observations).toContainEqual(expect.objectContaining({ code: "POST_AUDIT_FINDING_UNVERIFIED", assessment: "unavailable" }));
    // An unverified assessment must never be silently promoted to resolved.
    expect(saved.observations.filter(item => item.assessment === "resolved")).toHaveLength(0);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
  }, 30000);

  it("continues from a failed initial audit without regenerating the draft", async () => {
    const { runner, state, book, bookDir } = await fixture();
    const audit = vi.mocked(ContinuityAuditor.prototype.auditChapter)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ observations: [finding], summary: "Issue", tokenUsage: usage });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition], tokenUsage: usage });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision")
      .mockResolvedValue({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    expect((await state.loadChapterIndex(book.id))[0]?.autoRevision?.reason).toBe("audit-unavailable");
    expect(revise).not.toHaveBeenCalled();
    const draftCalls = calls.filter(call => call.name === "submit_chapter_draft").length;
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED", chapterNumber: 1 });
    expect(calls.filter(call => call.name === "submit_chapter_draft")).toHaveLength(draftCalls);
    expect(audit).toHaveBeenCalledTimes(1);

    const result = await runner.resumeChapter(book.id, 1);
    expect(result.autoRevision).toMatchObject({ status: "applied", reason: "revised-text-accepted; post-audit-notes-attached" });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(calls.filter(call => call.name === "submit_chapter_draft")).toHaveLength(draftCalls);
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
  }, 30000);

  it("saves the revision and canon when post-audit fails during resume", async () => {
    const { runner, state, book, bookDir } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter)
      .mockRejectedValueOnce(new Error("initial audit unavailable"))
      .mockResolvedValueOnce({ observations: [finding], summary: "Issue", tokenUsage: usage });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition], tokenUsage: usage });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision")
      .mockRejectedValueOnce(new Error("post audit unavailable"))
      .mockResolvedValueOnce({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    const result = await runner.resumeChapter(book.id, 1);
    expect(result.autoRevision?.reason).toBe("revised-text-accepted; post-audit-unavailable");
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.autoRevision).toMatchObject({ status: "applied", reason: "revised-text-accepted; post-audit-unavailable" });
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
    const snapshot = await loadRuntimeStateSnapshot(bookDir);
    expect(snapshot.manifest.lastAppliedChapter).toBe(1);
    await runner.resumeChapter(book.id, 1);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledTimes(1);
  }, 30000);

  it("retries a failed revision using the saved audit findings", async () => {
    const { runner, state, book } = await fixture();
    const audit = vi.mocked(ContinuityAuditor.prototype.auditChapter)
      .mockResolvedValue({ observations: [finding], summary: "Issue", tokenUsage: usage });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockRejectedValueOnce(new Error("reviser unavailable"))
      .mockResolvedValueOnce({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition], tokenUsage: usage });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision")
      .mockResolvedValue({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    expect((await state.loadChapterIndex(book.id))[0]?.autoRevision?.status).toBe("unavailable");
    const draftCalls = calls.filter(call => call.name === "submit_chapter_draft").length;

    const result = await runner.resumeChapter(book.id, 1);
    expect(result.autoRevision?.status).toBe("applied");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(2);
    expect(revise.mock.calls[1]?.[3]).toEqual([finding]);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(calls.filter(call => call.name === "submit_chapter_draft")).toHaveLength(draftCalls);
  }, 30000);

  it("refuses to resume after the saved chapter was edited by the user", async () => {
    const { runner, book, bookDir } = await fixture();
    const audit = vi.mocked(ContinuityAuditor.prototype.auditChapter).mockRejectedValue(new Error("offline"));
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    const path = join(bookDir, "chapters", file);
    const edited = `${await readFile(path, "utf8")}\nРучная правка.\n`;
    await writeFile(path, edited, "utf8");
    await expect(runner.resumeChapter(book.id, 1)).rejects.toMatchObject({ code: "CHAPTER_RESUME_CHAPTER_CHANGED" });
    expect(await readFile(path, "utf8")).toBe(edited);
    expect(audit).toHaveBeenCalledTimes(1);
  }, 30000);

  it("reuses the revision when settlement of that revision fails", async () => {
    const { runner, state, book } = await fixture();
    const audit = vi.mocked(ContinuityAuditor.prototype.auditChapter)
      .mockResolvedValue({ observations: [finding], summary: "Issue", tokenUsage: usage });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition], tokenUsage: usage });
    const settleOriginal = WriterAgent.prototype.settleChapterState;
    const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState")
      .mockRejectedValueOnce(new Error("settlement unavailable"))
      .mockImplementation(function (this: WriterAgent, ...args) { return settleOriginal.apply(this, args); });
    const compare = vi.spyOn(ContinuityAuditor.prototype, "compareRevision")
      .mockResolvedValue({ assessments: [assessment], newIssues: [], tokenUsage: usage });
    await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    expect((await state.loadChapterIndex(book.id))[0]?.autoRevision?.status).toBe("candidate");
    const result = await runner.resumeChapter(book.id, 1);
    expect(result.autoRevision?.status).toBe("applied");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(3);
    expect(compare).toHaveBeenCalledTimes(1);
  }, 30000);

  it("accepts the Reviser's text even when the Auditor reports a remaining issue", async () => {
    const { runner, state, book, bookDir } = await fixture();
    vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [finding], summary: "Issue" });
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: revised, wordCount: 9, findingDispositions: [disposition] });
    vi.spyOn(ContinuityAuditor.prototype, "compareRevision").mockResolvedValue({ assessments: [{ ...assessment, status: "remaining" }], newIssues: [], tokenUsage: usage });
    const result = await runner.writeNextChapter(book.id);
    expect(result.autoRevision).toMatchObject({ status: "applied", reason: "revised-text-accepted; post-audit-notes-attached" });
    const saved = (await state.loadChapterIndex(book.id))[0]!;
    expect(saved.observations).toContainEqual(expect.objectContaining({ code: "character", assessment: "issue" }));
    const file = (await readdir(join(bookDir, "chapters"))).find(name => name.endsWith(".md"))!;
    expect(await readFile(join(bookDir, "chapters", file), "utf8")).toContain(revised);
  }, 30000);

  it("sends complete findings and validates the Reviser's report in its structured tool", async () => {
    const { root, book, bookDir } = await fixture();
    const agent = new ReviserAgent({ projectRoot: root, client, model: "unused", bookId: book.id });
    const findings = [{ id: "finding-1", observation: finding }];
    vi.mocked(runWorkerAgentTool).mockImplementationOnce(async (_client, _model, messages, tool, options) => {
      const payload = { revisedContent: revised, findingDispositions: [disposition] };
      expect(Value.Check(tool.parameters, payload)).toBe(true);
      expect(options?.disableRetries).toBe(true);
      const prompt = messages.map(message => message.content).join("\n");
      expect(prompt).toContain('"sourceRefs"');
      expect(prompt).toContain('"quote":"Ёж"');
      expect(prompt).toContain("execution-only finding");
      expect(prompt).toContain("Preserve facts");
      expect(prompt).toContain("Revision narrative language");
      expect(prompt).toContain("ROOT AUTHOR REQUEST: keep the narrator");
      options?.onUsage?.(usage);
      return (tool.validate ? await tool.validate(payload as never) : payload) as never;
    });
    const result = await withExecutionEvidence(() => {}, () => agent.reviseChapter(bookDir, prose, 1, [finding], "rewrite", "general", {
      language: "en", narrativeLanguage: "ru", contextPackage: { chapter: 1, selectedContext: [{ source: "rules", reason: "canon", excerpt: "Preserve facts", protection: "protected" }] },
      autoFindings: findings, auditContext: { summary: "Full audit", observations: [{ code: "execution-only", summary: "execution-only finding", category: "execution", assessment: "issue", evidence: [] }] },
    }), undefined, undefined, "ROOT AUTHOR REQUEST: keep the narrator");
    expect(result.findingDispositions).toEqual([disposition]);
    expect(result.tokenUsage).toEqual(usage);
  });

  it("rejects an incomplete Reviser's report without accepting the candidate", async () => {
    const { root, book, bookDir } = await fixture();
    const agent = new ReviserAgent({ projectRoot: root, client, model: "unused", bookId: book.id });
    vi.mocked(runWorkerAgentTool).mockImplementationOnce(async (_client, _model, _messages, tool) => {
      const payload = { revisedContent: revised };
      expect(Value.Check(tool.parameters, payload)).toBe(true);
      return (tool.validate ? await tool.validate(payload as never) : payload) as never;
    });
    let candidate = "";
    await expect(agent.reviseChapter(bookDir, prose, 1, [finding], "rewrite", "general", {
      language: "en", narrativeLanguage: "ru", contextPackage: { chapter: 1, selectedContext: [] },
      autoFindings: [{ id: "finding-1", observation: finding }], onCandidate: async text => { candidate = text; },
    })).rejects.toThrow(/finding/i);
    expect(candidate).toBe(revised);
  });

  it("keeps the finding report on the scoped editing path", async () => {
    const { root, book, bookDir } = await fixture();
    const agent = new ReviserAgent({ projectRoot: root, client, model: "unused", bookId: book.id });
    const localFinding = { ...finding, scope: "local" };
    const replies = [
      { ranges: [{ startLine: 1, endLine: 1 }] },
      { range_0_content: revised, findingDispositions: [disposition] },
    ];
    vi.mocked(runWorkerAgentTool).mockImplementation(async (_client, _model, _messages, tool, options) => {
      const payload = replies.shift();
      expect(payload).toBeDefined();
      expect(Value.Check(tool.parameters, payload)).toBe(true);
      expect(options?.disableRetries).toBe(true);
      options?.onUsage?.(usage);
      return (tool.validate ? await tool.validate(payload as never) : payload) as never;
    });
    const result = await agent.reviseChapter(bookDir, prose, 1, [localFinding], "spot-fix", "general", {
      language: "en", narrativeLanguage: "ru", contextPackage: { chapter: 1, selectedContext: [] },
      autoFindings: [{ id: "finding-1", observation: localFinding }],
    });
    expect(result.revisedContent).toBe(revised);
    expect(result.findingDispositions).toEqual([disposition]);
    expect(result.tokenUsage?.totalTokens).toBe(10);
  });

  it("requires evidence and a complete comparison from the Auditor", async () => {
    const { root, book } = await fixture();
    const auditor = new ContinuityAuditor({ projectRoot: root, client, model: "unused", bookId: book.id });
    vi.mocked(runWorkerAgentTool).mockImplementationOnce(async (_client, _model, messages, tool, options) => {
      const payload = { assessments: [assessment], newIssues: [] };
      expect(Value.Check(tool.parameters, payload)).toBe(true);
      expect(options?.disableRetries).toBe(true);
      expect(messages.map(message => message.content).join("\n")).toContain('"finding-1"');
      expect(messages.map(message => message.content).join("\n")).toContain('"expectedFindingIds":["finding-1"]');
      expect(messages.map(message => message.content).join("\n")).toContain('Do not paraphrase, join separate passages, add ellipses');
      options?.onUsage?.(usage);
      return (tool.validate ? await tool.validate(payload as never) : payload) as never;
    });
    const result = await auditor.compareRevision({ chapterNumber: 1, original: prose, candidate: revised,
      findings: [{ id: "finding-1", observation: finding }], language: "en", narrativeLanguage: "ru", contextPackage: { chapter: 1, selectedContext: [] } });
    expect(result.assessments).toEqual([assessment]);
    expect(result.tokenUsage).toEqual(usage);
    vi.mocked(runWorkerAgentTool).mockImplementationOnce(async (_client, _model, _messages, tool) => {
      const payload = { assessments: [], newIssues: [] };
      return (tool.validate ? await tool.validate(payload as never) : payload) as never;
    });
    const missing = await auditor.compareRevision({ chapterNumber: 1, original: prose, candidate: revised,
      findings: [{ id: "finding-1", observation: finding }], language: "en", narrativeLanguage: "ru", contextPackage: { chapter: 1, selectedContext: [] } });
    expect(missing.warnings).toContainEqual(expect.objectContaining({ code: "POST_AUDIT_FINDING_MISSING", findingId: "finding-1" }));
  });

  it("restores exact evidence after whitespace-only changes but rejects ambiguous matches", async () => {
    const { root, book } = await fixture();
    const auditor = new ContinuityAuditor({ projectRoot: root, client, model: "unused", bookId: book.id });
    const candidate = "Начало.\n\nЁж увидел пристань.\nКонец.";
    const payload = { assessments: [{ ...assessment, evidence: "Начало. Ёж увидел пристань." }], newIssues: [] };
    vi.mocked(runWorkerAgentTool).mockImplementationOnce(async (_client, _model, _messages, tool) =>
      (tool.validate ? await tool.validate(payload as never) : payload) as never);
    const input = { chapterNumber: 1, original: prose, candidate, findings: [{ id: "finding-1", observation: finding }],
      language: "en" as const, narrativeLanguage: "ru" as const, contextPackage: { chapter: 1, selectedContext: [] } };
    const result = await auditor.compareRevision(input);
    expect(result.assessments[0]?.evidence).toBe("Начало.\n\nЁж увидел пристань.");

    vi.mocked(runWorkerAgentTool).mockImplementationOnce(async (_client, _model, _messages, tool) =>
      (tool.validate ? await tool.validate(payload as never) : payload) as never);
    const ambiguous = await auditor.compareRevision({ ...input, candidate: `${candidate}\n${candidate}` });
    expect(ambiguous.assessments).toEqual([]);
    expect(ambiguous.warnings).toContainEqual(expect.objectContaining({ code: "POST_AUDIT_FINDING_UNVERIFIED", findingId: "finding-1" }));
  });

  it.each(["manual", "unavailable", "partial", "execution"] as const)("does not revise for %s", async mode => {
    const { runner, state, book } = await fixture();
    if (mode === "manual") await state.saveBookConfig(book.id, { ...book, writing: { reviewMode: "manual" } });
    if (mode === "unavailable") vi.mocked(ContinuityAuditor.prototype.auditChapter).mockRejectedValue(new Error("offline"));
    else vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue({ observations: [
      { ...finding, ...(mode === "execution" ? { category: "execution" as const } : {}) },
      ...(mode === "partial" ? [{ code: "missing-source", summary: "Source unavailable", assessment: "unavailable" as const, evidence: [] }] : []),
    ], summary: "Issue" });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter");
    if (mode === "unavailable" || mode === "partial") {
      await expect(runner.writeNextChapter(book.id)).rejects.toMatchObject({ code: "CHAPTER_RESUME_REQUIRED" });
    } else {
      const result = await runner.writeNextChapter(book.id);
      expect(result.autoRevision?.status).toBe("skipped");
    }
    expect(revise).not.toHaveBeenCalled();
  }, 30000);
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
  for (const call of audits) expect(call[4]).toMatchObject({ language: "en", narrativeLanguage: "ru" });
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

  it("keeps Auditor operations in English and localizes its report and fallback to Russian", async () => {
    const auditor = { auditChapter: vi.fn().mockRejectedValue(Object.assign(new Error("fixture unavailable"), { tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } })) };
    const result = await reviewChapterDraft({
      book: { genre: "general", language: "en", narrativeLanguage: "ru" }, bookDir: "unused", chapterNumber: 1, output: { content: prose },
      controlInput: { contextPackage: { chapter: 1, selectedContext: [] } },
      lengthSpec: buildLengthSpec(9, "en", { narrativeLanguage: "ru", minChapterLength: 8, maxChapterLength: 10 }),
      initialUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, auditor,
      assertNotEmpty: () => {}, addUsage: (left, right) => ({ promptTokens: left.promptTokens + (right?.promptTokens ?? 0), completionTokens: left.completionTokens + (right?.completionTokens ?? 0), totalTokens: left.totalTokens + (right?.totalTokens ?? 0) }),
    });
    expect(result.wordCount).toBe(8);
    expect(auditor.auditChapter.mock.calls[0]?.[4]).toMatchObject({ language: "en", narrativeLanguage: "ru" });
    expect(result.review.summary).toBe("Аудит недоступен");
    expect(result.totalUsage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    expect(result.review.observations[0]?.summary).toContain("Наблюдение аудитора недоступно:");
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
