import { readFile, lstat, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import { ContextPackageSchema } from "../models/input-governance.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";
import { resolveNarrativeLanguage } from "../utils/book-language.js";
import { readChapterVersion } from "../state/chapter-workspace.js";
import { buildRuntimeStateArtifactsFromSnapshot, loadRuntimeStateSnapshot, loadRuntimeStateSnapshotAtChapter } from "../state/runtime-state-store.js";
import { loadPersistedPlan } from "./persisted-governed-plan.js";
import { ChapterCheckpoint, chapterAuthorityHashes, chapterBookIdentity } from "./chapter-checkpoint.js";

const ArchiveSchema = z.object({ workId: z.string(), agentRole: z.string(),
  validation: z.object({ stages: z.array(z.object({ stage: z.string(), status: z.string() }).passthrough()) }).passthrough(),
  response: z.object({ stopReason: z.string(), content: z.array(z.unknown()),
    usage: z.object({ input: z.number(), output: z.number(), totalTokens: z.number() }).passthrough() }).passthrough(),
}).passthrough();
const EventPayloadSchema = z.object({ artifactPath: z.string(), role: z.string(), resultTool: z.string() }).passthrough();
const ActionSchema = z.object({ parameters: z.object({ bookId: z.string(), startChapterNumber: z.number().int(),
  chapterCount: z.number().int(), chapterWordCount: z.number().int().positive().optional(), instruction: z.string() }).passthrough() }).passthrough();

type EpisodeEvent = { seq: number; timestamp: string; type: string; payload_json: string };

function fail(message: string): never {
  throw Object.assign(new Error(`Cannot recover legacy chapter safely: ${message}`), { code: "CHAPTER_LEGACY_EVIDENCE_INSUFFICIENT" });
}

function passedArchive(archive: z.infer<typeof ArchiveSchema>, bookId: string, role: string, tool: string): Record<string, unknown> {
  if (archive.workId !== bookId || archive.agentRole !== role || archive.response.stopReason !== "toolUse") fail(`invalid ${tool} response identity`);
  const stages = archive.validation.stages;
  if (!stages.some(item => item.stage === "schema" && item.status === "passed")
    || !stages.some(item => item.stage === "domain" && item.status === "passed")
    || stages.some(item => item.status === "failed")) fail(`${tool} response was not fully validated`);
  const calls = archive.response.content.filter(item => item && typeof item === "object"
    && (item as { type?: unknown }).type === "toolCall" && (item as { name?: unknown }).name === tool);
  if (calls.length !== 1) fail(`ambiguous ${tool} response`);
  return z.record(z.unknown()).parse((calls[0] as { arguments?: unknown }).arguments);
}

async function readEpisodeArchive(projectRoot: string, bookId: string, event: EpisodeEvent): Promise<z.infer<typeof ArchiveSchema>> {
  const payload = EventPayloadSchema.parse(JSON.parse(event.payload_json));
  const directory = resolve(projectRoot, ".inkos", "agent-runs", encodeURIComponent(bookId).replace(/\./g, "%2E"), "worker-responses");
  const path = resolve(payload.artifactPath);
  const within = relative(directory, path);
  if (!within || within !== basename(within) || isAbsolute(within) || within === "..") fail("response archive path is outside this work");
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) fail("response archive is not a regular file");
  return ArchiveSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Recover only a persisted draft whose complete production episode can be independently matched. */
export async function bootstrapLegacyAuditCheckpoint(input: {
  projectRoot: string; bookId: string; bookDir: string; book: BookConfig; chapter: ChapterMeta;
  sourceState: ReadonlyMap<string, string>; currentContent: string;
}): Promise<ChapterCheckpoint> {
  const { projectRoot, bookId, bookDir, book, chapter, sourceState, currentContent } = input;
  const revision = chapter.autoRevision;
  if (revision?.status !== "skipped" || revision.reason !== "audit-unavailable" || !revision.originalVersionId
    || !chapter.observations.some(item => item.code === "review-unavailable") || !chapter.tokenUsage || !revision.initialReview) {
    fail("the latest chapter is not a saved draft with an unavailable initial audit");
  }
  const match = /^(\d{13})_agent_[0-9a-f-]{36}$/.exec(revision.originalVersionId);
  if (!match) fail("draft version identity is invalid");
  const draftTime = Number(match[1]);
  const archivedDraft = await readChapterVersion(bookDir, chapter.number, revision.originalVersionId);
  if (archivedDraft !== currentContent) fail("the saved chapter differs from the original draft");
  const dbPath = join(projectRoot, ".inkos", "harness.sqlite");
  try { await stat(dbPath); } catch { fail("production episode journal is missing"); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let selected: { action: z.infer<typeof ActionSchema>; startedAt: string; events: EpisodeEvent[];
    draft: z.infer<typeof ArchiveSchema>; draftArgs: Record<string, unknown>; draftSeq: number } | undefined;
  try {
    const actions = db.prepare("SELECT episode_id, timestamp, payload_json FROM creative_episode_events WHERE work_id = ? AND type = 'action-started' AND action_id = 'write_chapters' AND timestamp <= ? ORDER BY timestamp DESC LIMIT 100")
      .all(bookId, new Date(draftTime + 1000).toISOString()) as unknown as Array<{ episode_id: string; timestamp: string; payload_json: string }>;
    for (const row of actions) {
      const parsed = ActionSchema.safeParse(JSON.parse(row.payload_json));
      if (!parsed.success || parsed.data.parameters.bookId !== bookId || parsed.data.parameters.startChapterNumber !== chapter.number
        || parsed.data.parameters.chapterCount !== 1) continue;
      const events = db.prepare("SELECT seq, timestamp, type, payload_json FROM creative_episode_events WHERE episode_id = ? ORDER BY seq")
        .all(row.episode_id) as unknown as EpisodeEvent[];
      for (const event of events.filter(item => item.type === "worker-response-archived")) {
        const payload = EventPayloadSchema.safeParse(JSON.parse(event.payload_json));
        const eventTime = Date.parse(event.timestamp);
        if (!payload.success || payload.data.role !== "writer" || payload.data.resultTool !== "submit_chapter_draft"
          || !Number.isFinite(eventTime) || Math.abs(eventTime - draftTime) > 30_000) continue;
        const archive = await readEpisodeArchive(projectRoot, bookId, event);
        const args = passedArchive(archive, bookId, "writer", "submit_chapter_draft");
        if (typeof args.content === "string" && args.content.trim() === archivedDraft
          && typeof args.title === "string" && args.title.trim() === chapter.title) {
          selected = { action: parsed.data, startedAt: row.timestamp, events, draft: archive, draftArgs: args, draftSeq: event.seq };
          break;
        }
      }
      if (selected) break;
    }
  } finally { db.close(); }
  if (!selected) fail("no production episode matches the saved draft");

  const startedTime = Date.parse(selected.startedAt);
  if (!Number.isFinite(startedTime)) fail("episode timestamp is invalid");
  const stableSources = chapterAuthorityHashes(sourceState, chapter.number);
  for (const path of [...Object.keys(stableSources), "source/book.json"]) {
    const file = await stat(join(bookDir, path.slice("source/".length)));
    if (file.mtimeMs > startedTime + 1000) fail(`book source changed after the episode began: ${path}`);
  }
  const plan = await loadPersistedPlan(bookDir, chapter.number);
  if (!plan) fail("saved chapter plan is missing");
  const contextPath = join(bookDir, "story", "runtime", `chapter-${String(chapter.number).padStart(4, "0")}.context.json`);
  const contextPackage = ContextPackageSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  if (contextPackage.chapter !== chapter.number || (await stat(contextPath)).mtimeMs > draftTime + 1000) fail("saved context does not belong to the draft");
  const promptEvent = [...selected.events].reverse().find(event => event.seq < selected!.draftSeq && event.type === "model-call-started"
    && JSON.stringify(JSON.parse(event.payload_json).context?.tools ?? []).includes("submit_chapter_draft"));
  if (!promptEvent) fail("author request is missing from the episode");
  const prompt = JSON.stringify(JSON.parse(promptEvent.payload_json).context);
  const contains = (value: string) => prompt.includes(JSON.stringify(value).slice(1, -1));
  if (!contains(plan.memo.goal) || !contains(plan.memo.body)
    || contextPackage.selectedContext.some(source => source.excerpt && !contains(source.excerpt))) fail("saved plan or context differs from the author request");
  const instruction = selected.action.parameters.instruction.trim();
  const generic = instruction === "Write the requested consecutive chapters for the active Work."
    || instruction === `Rewrite chapter ${chapter.number}.`;
  const externalContext = generic ? undefined : instruction;
  if (externalContext && !contains(externalContext)) fail("original chapter instruction is absent from the author request");

  const baseline = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: chapter.number - 1, language: book.language });
  const live = await loadRuntimeStateSnapshot(bookDir);
  const savedSnapshot = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: chapter.number, language: book.language });
  if (!isDeepStrictEqual(live, savedSnapshot) || live.manifest.lastAppliedChapter !== chapter.number) fail("current canon does not match the chapter snapshot");
  const archiveEvents = selected.events.filter(event => event.type === "worker-response-archived" && event.seq > selected!.draftSeq);
  const byTool = (tool: string) => archiveEvents.filter(event => {
    const payload = EventPayloadSchema.safeParse(JSON.parse(event.payload_json));
    return payload.success && payload.data.resultTool === tool;
  });
  const validatorEvents = byTool("submit_state_validation");
  const validatorEvent = validatorEvents.at(-1);
  if (!validatorEvent) fail("state validation response is missing");
  const validationArchive = await readEpisodeArchive(projectRoot, bookId, validatorEvent);
  const validationArgs = passedArchive(validationArchive, bookId, "state-validator", "submit_state_validation");
  if (validationArgs.reconciliationRequired !== false || typeof validationArgs.reportMarkdown !== "string") fail("state validation was not successful");
  const settlementEvents = byTool("submit_runtime_state_delta").filter(event => event.seq < validatorEvent.seq);
  const settlementEvent = settlementEvents.at(-1);
  if (!settlementEvent) fail("settlement response is missing");
  const settlementArchive = await readEpisodeArchive(projectRoot, bookId, settlementEvent);
  const settlement = passedArchive(settlementArchive, bookId, "writer", "submit_runtime_state_delta");
  if (typeof settlement.postSettlement !== "string" || !settlement.chapterSummary || typeof settlement.chapterSummary !== "object") fail("settlement response is incomplete");
  const delta = RuntimeStateDeltaSchema.parse({ chapter: chapter.number, factOps: settlement.factOps, hookOps: settlement.hookOps,
    newHookCandidates: settlement.newHookCandidates, chapterSummary: { ...(settlement.chapterSummary as object), chapter: chapter.number } });
  const rebuilt = buildRuntimeStateArtifactsFromSnapshot({ snapshot: baseline, delta, language: book.language,
    projectionLanguage: resolveNarrativeLanguage(book) });
  if (!isDeepStrictEqual(rebuilt.snapshot, live)) fail("archived settlement does not reproduce current canon");
  const draftUsage = { promptTokens: selected.draft.response.usage.input, completionTokens: selected.draft.response.usage.output,
    totalTokens: selected.draft.response.usage.totalTokens };
  const settlementUsage = { promptTokens: settlementArchive.response.usage.input, completionTokens: settlementArchive.response.usage.output,
    totalTokens: settlementArchive.response.usage.totalTokens };
  const output = { chapterNumber: chapter.number, title: chapter.title, content: currentContent, wordCount: chapter.wordCount, tokenUsage: draftUsage };
  const persistenceOutput = { ...output, postSettlement: settlement.postSettlement, runtimeStateDelta: rebuilt.resolvedDelta,
    runtimeStateSnapshot: rebuilt.snapshot, updatedState: rebuilt.currentStateMarkdown, updatedHooks: rebuilt.hooksMarkdown,
    updatedChapterSummaries: rebuilt.chapterSummariesMarkdown, runtimeStateApplied: true,
    tokenUsage: { promptTokens: draftUsage.promptTokens + settlementUsage.promptTokens,
      completionTokens: draftUsage.completionTokens + settlementUsage.completionTokens, totalTokens: draftUsage.totalTokens + settlementUsage.totalTokens } };
  const observations = validationArgs.reportMarkdown.trim() ? [{ code: "state-projection-review", summary: validationArgs.reportMarkdown.trim(), evidence: [] }] : [];
  const truth = { validation: { consistent: true, reconciliationRequired: false, observations }, persistenceOutput };
  const totalUsage = chapter.tokenUsage;
  const initialReview = revision.initialReview;
  return ChapterCheckpoint.createFromRecords(projectRoot, bookId, chapter.number, [
    { stage: "started", status: "completed", data: { wordCount: selected.action.parameters.chapterWordCount ?? chapter.lengthTelemetry?.target ?? book.chapterWordCount, externalContext } },
    { stage: "baseline", status: "completed", data: { runtimeSnapshot: baseline, authorityHashes: stableSources, bookIdentity: chapterBookIdentity(book) } },
    { stage: "prepared", status: "completed", data: { externalContext, chapterIntent: plan.intentMarkdown, chapterMemo: plan.memo, chapterIntentData: plan.intent, contextPackage } },
    { stage: "draft", status: "completed", data: { output, draftVersion: { id: revision.originalVersionId } } },
    { stage: "audit", status: "failed", data: { content: currentContent, wordCount: chapter.wordCount, review: initialReview, totalUsage } },
    { stage: "revision", status: "skipped", data: { autoRevision: revision, finalContent: currentContent, totalUsage } },
    { stage: "settlement", status: "completed", data: { candidate: false, content: currentContent, persistenceOutput, totalUsage } },
    { stage: "state-validation", status: "completed", data: truth },
    { stage: "post-audit", status: "skipped", data: { autoRevision: revision, auditResult: initialReview, totalUsage, content: currentContent } },
    { stage: "persisted", status: "incomplete", data: { chapterNumber: chapter.number, title: chapter.title, content: currentContent,
      autoRevision: revision, auditResult: initialReview, finalWordCount: chapter.wordCount, lengthTelemetry: chapter.lengthTelemetry, totalUsage } },
  ]);
}
