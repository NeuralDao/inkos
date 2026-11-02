import type { AuditResult } from "../agents/continuity.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { AutoRevisionOutcome } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly auditResult: AuditResult;
  readonly finalWordCount: number;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly autoRevision?: AutoRevisionOutcome;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapter: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta }> {
  const existingIndex = await params.loadChapterIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    wordCount: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    observations: [...params.auditResult.observations],
    provenance: "generated",
    lengthTelemetry: params.lengthTelemetry,
    tokenUsage: params.tokenUsage,
    ...(params.autoRevision ? { autoRevision: params.autoRevision } : {}),
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt } : e)
    : [...existingIndex, entry];
  await params.saveChapter(updatedIndex);
  await params.markBookActiveIfNeeded();

  return { entry };
}
