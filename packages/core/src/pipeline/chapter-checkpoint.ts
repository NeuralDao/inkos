import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { BookConfig } from "../models/book.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { withChapterStage, isChapterResumeSafetyError } from "../agent/chapter-stage-context.js";

const RecordSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(["completed", "failed", "skipped", "candidate", "incomplete", "running"]),
  at: z.string().datetime(),
  data: z.unknown().optional(),
}).strict();
const CheckpointSchema = z.object({
  version: z.literal(1), operationId: z.string().uuid(), bookId: z.string().min(1),
  chapterNumber: z.number().int().positive(), records: z.array(RecordSchema),
}).strict();
const UsageSchema = z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative() });
export type ChapterCheckpointRecord = z.infer<typeof RecordSchema>;
type CheckpointStatus = ChapterCheckpointRecord["status"];

function checkpointDirectory(bookId: string): string {
  return join(".inkos", "chapter-runs", encodeURIComponent(bookId).replace(/\./g, "%2E"));
}

/** Stable book sources used to detect edits made after an operation began. */
export function chapterAuthorityHashes(sourceState: ReadonlyMap<string, string>, chapterNumber: number): Record<string, string> {
  const volatile = /^(?:source\/book\.json$|source\/chapters\/|source\/story\/(?:runtime|state|snapshots)\/|source\/story\/(?:current_state|pending_hooks|chapter_summaries|volume_summaries)\.md$|source\/story\/memory\.db(?:-shm|-wal)?$)/;
  return Object.fromEntries([...sourceState.entries()].filter(([path]) => {
    const chapter = /^source\/chapters\/(\d+)_.*\.md$/i.exec(path);
    return chapter ? Number(chapter[1]) < chapterNumber : !volatile.test(path);
  }).sort(([a], [b]) => a.localeCompare(b)));
}

export function chapterBookIdentity(book: BookConfig): Omit<BookConfig, "status" | "updatedAt"> {
  const { status: _status, updatedAt: _updatedAt, ...identity } = book;
  return identity;
}

/** Verify that a saved operation still refers to the same canon baseline and book sources. */
export function assertChapterCheckpointBaseline(
  record: ChapterCheckpointRecord | undefined,
  sourceState: ReadonlyMap<string, string>,
  runtimeSnapshot: unknown,
  book: BookConfig,
  chapterNumber: number,
): void {
  if (!record || record.stage !== "baseline" || record.status !== "completed") {
    throw Object.assign(new Error("Chapter checkpoint has no completed baseline"), { code: "CHAPTER_CHECKPOINT_BASELINE_MISSING" });
  }
  const baseline = z.object({ runtimeSnapshot: z.unknown(), authorityHashes: z.record(z.string()), bookIdentity: z.unknown() }).strict().parse(record.data);
  if (!isDeepStrictEqual(baseline.bookIdentity, chapterBookIdentity(book))) {
    throw Object.assign(new Error("Book configuration changed since the chapter operation began"), { code: "CHAPTER_CHECKPOINT_BOOK_CHANGED" });
  }
  if (!isDeepStrictEqual(baseline.authorityHashes, chapterAuthorityHashes(sourceState, chapterNumber))) {
    throw Object.assign(new Error("Book sources changed since the chapter operation began"), { code: "CHAPTER_CHECKPOINT_AUTHORITY_CHANGED" });
  }
  if (!isDeepStrictEqual(baseline.runtimeSnapshot, runtimeSnapshot)) {
    throw Object.assign(new Error("Chapter baseline state changed since the operation began"), { code: "CHAPTER_CHECKPOINT_BASELINE_CHANGED" });
  }
}

/** Persist chapter stage outputs locally before a later stage can fail. */
export class ChapterCheckpoint {
  private readonly operationId: string;
  private records: ChapterCheckpointRecord[];
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly relativePath: string;

  constructor(private readonly projectRoot: string, private readonly bookId: string, private readonly chapterNumber: number,
    restored?: { readonly operationId: string; readonly records: ChapterCheckpointRecord[] }) {
    this.operationId = restored?.operationId ?? randomUUID();
    this.records = restored?.records ?? [];
    this.relativePath = join(checkpointDirectory(bookId),
      `chapter-${String(chapterNumber).padStart(4, "0")}-${this.operationId}.json`);
  }

  /** Import verified legacy evidence as one atomic checkpoint, never a half-built operation. */
  static async createFromRecords(projectRoot: string, bookId: string, chapterNumber: number,
    entries: ReadonlyArray<{ stage: string; status: CheckpointStatus; data: unknown }>): Promise<ChapterCheckpoint> {
    const checkpoint = new ChapterCheckpoint(projectRoot, bookId, chapterNumber);
    const records = z.array(RecordSchema).parse(entries.map(entry => ({ ...entry, at: new Date().toISOString() })));
    await checkpoint.save(records);
    return checkpoint;
  }

  /** Load the newest operation for a chapter. A corrupt newest record is an error, not permission to use an older run. */
  static async latest(projectRoot: string, bookId: string, chapterNumber: number): Promise<ChapterCheckpoint | undefined> {
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) throw new Error("Invalid checkpoint chapter number");
    const directory = join(projectRoot, checkpointDirectory(bookId));
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const prefix = `chapter-${String(chapterNumber).padStart(4, "0")}-`;
    const candidates = await Promise.all(files.filter(file => file.startsWith(prefix) && file.endsWith(".json"))
      .map(async file => ({ file, modified: (await stat(join(directory, file))).mtimeMs })));
    candidates.sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file));
    if (!candidates.length) return undefined;
    if (candidates.length > 1 && candidates[0]!.modified === candidates[1]!.modified) {
      throw Object.assign(new Error("Cannot determine the newest chapter operation"), { code: "CHAPTER_CHECKPOINT_ORDER_AMBIGUOUS" });
    }
    const file = candidates[0]!.file;
    const saved = CheckpointSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8")));
    if (saved.bookId !== bookId || saved.chapterNumber !== chapterNumber || file !== `${prefix}${saved.operationId}.json`) {
      throw new Error("Chapter checkpoint identity does not match its path");
    }
    return new ChapterCheckpoint(projectRoot, bookId, chapterNumber, { operationId: saved.operationId, records: saved.records });
  }

  /** Select the most recently updated operation, including a rewrite of an earlier chapter. */
  static async latestForBook(projectRoot: string, bookId: string): Promise<ChapterCheckpoint | undefined> {
    const directory = join(projectRoot, checkpointDirectory(bookId));
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const chapters = files.flatMap(file => {
      const match = /^chapter-(\d+)-[0-9a-f-]+\.json$/i.exec(file);
      return match ? [{ file, chapter: Number(match[1]) }] : [];
    }).filter(item => Number.isSafeInteger(item.chapter) && item.chapter > 0);
    if (!chapters.length) return undefined;
    const candidates = await Promise.all(chapters.map(async item => ({ ...item, modified: (await stat(join(directory, item.file))).mtimeMs })));
    candidates.sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file));
    if (candidates.length > 1 && candidates[0]!.modified === candidates[1]!.modified) {
      throw Object.assign(new Error("Cannot determine the newest book operation"), { code: "CHAPTER_CHECKPOINT_ORDER_AMBIGUOUS" });
    }
    return ChapterCheckpoint.latest(projectRoot, bookId, candidates[0]!.chapter);
  }

  get chapter(): number { return this.chapterNumber; }

  /** A missing baseline can only be reconstructed before any stage has started. */
  hasStartedStage(): boolean {
    return this.records.some(record => record.stage.endsWith("-started") && record.stage !== "started");
  }

  /** Record request boundaries and tag raw worker responses with this operation and stage. */
  async runStage<T>(stage: string, task: () => Promise<T>, recovering = false): Promise<T> {
    const started = this.records.map(record => record.stage).lastIndexOf(`${stage}-started`);
    const finished = Math.max(this.records.map(record => record.stage).lastIndexOf(stage),
      this.records.map(record => record.stage).lastIndexOf(`${stage}-error`));
    const interrupted = recovering && started > finished;
    let attemptId: string;
    if (interrupted) {
      const previous = z.object({ attemptId: z.string().uuid() }).safeParse(this.records[started]!.data);
      if (!previous.success) throw Object.assign(new Error(`The interrupted ${stage} operation has no request identity`), {
        code: "CHAPTER_RESUME_AMBIGUOUS_STAGE", chapterNumber: this.chapterNumber, stage,
      });
      attemptId = previous.data.attemptId;
    } else {
      attemptId = randomUUID();
      await this.record(`${stage}-started`, "running", { attemptId });
    }
    const requestSchema = z.object({ attemptId: z.string().uuid(), sequence: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
    const previousRequests = this.records.flatMap(record => {
      if (record.stage !== `${stage}-request-started` || !record.data || typeof record.data !== "object"
        || (record.data as { attemptId?: unknown }).attemptId !== attemptId) return [];
      return [requestSchema.parse(record.data)];
    });
    if (new Set(previousRequests.map(request => request.sequence)).size !== previousRequests.length) {
      throw Object.assign(new Error(`Duplicate request identity in ${stage} checkpoint`), { code: "CHAPTER_RESUME_INPUT_CHANGED" });
    }
    const usedRequests = new Set<number>();
    let sequence = previousRequests.reduce((max, request) => Math.max(max, request.sequence), 0);
    const beginRequest = async (fingerprint: string) => {
      const request = previousRequests.find(item => !usedRequests.has(item.sequence) && item.fingerprint === fingerprint);
      if (request) {
        usedRequests.add(request.sequence);
        return { sequence: request.sequence, replay: true };
      }
      if (usedRequests.size < previousRequests.length) throw Object.assign(new Error(`The ${stage} request changed since interruption`), {
        code: "CHAPTER_RESUME_INPUT_CHANGED", chapterNumber: this.chapterNumber, stage,
      });
      sequence += 1;
      await this.record(`${stage}-request-started`, "running", { attemptId, sequence, fingerprint });
      return { sequence, replay: false };
    };
    try {
      return await withChapterStage({ operationId: this.operationId, bookId: this.bookId,
        chapterNumber: this.chapterNumber, stage, attemptId, beginRequest }, task);
    } catch (error) {
      if (isChapterResumeSafetyError(error)) throw error;
      await this.record(`${stage}-error`, "failed", { message: String(error), code: (error as { code?: string })?.code });
      throw error;
    }
  }

  /** Return a stage only if it was recorded after the specified prerequisite. */
  latestRecordAfter(stage: string, prerequisite: string): ChapterCheckpointRecord | undefined {
    let prerequisiteIndex = -1;
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index]!.stage === prerequisite) { prerequisiteIndex = index; break; }
    }
    if (prerequisiteIndex < 0) return undefined;
    return this.records.slice(prerequisiteIndex + 1).reverse().find(record => record.stage === stage);
  }

  latestRecord(stage: string): ChapterCheckpointRecord | undefined {
    return [...this.records].reverse().find(record => record.stage === stage);
  }

  /** Preserve the accumulated usage of earlier attempts when continuing an operation. */
  latestCumulativeUsage(): z.infer<typeof UsageSchema> | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (!record.data || typeof record.data !== "object") continue;
      const data = record.data as { totalUsage?: unknown; output?: { tokenUsage?: unknown } };
      if (data.totalUsage !== undefined) return UsageSchema.parse(data.totalUsage);
      if (record.stage === "draft" && data.output?.tokenUsage !== undefined) return UsageSchema.parse(data.output.tokenUsage);
    }
    return undefined;
  }

  /** A completed but malformed stage is never treated as absent. */
  completed<T extends z.ZodTypeAny>(stage: string, schema: T): z.infer<T> | undefined {
    const record = this.latestRecord(stage);
    if (!record || record.status !== "completed") return undefined;
    return schema.parse(record.data);
  }

  completedAfter<T extends z.ZodTypeAny>(stage: string, prerequisite: string, schema: T): z.infer<T> | undefined {
    const record = this.latestRecordAfter(stage, prerequisite);
    if (!record || record.status !== "completed") return undefined;
    return schema.parse(record.data);
  }

  completedAfterAll<T extends z.ZodTypeAny>(stage: string, prerequisites: ReadonlyArray<string>, schema: T): z.infer<T> | undefined {
    let lastPrerequisite = -1;
    for (const prerequisite of prerequisites) {
      let found = -1;
      for (let index = this.records.length - 1; index >= 0; index -= 1) {
        if (this.records[index]!.stage === prerequisite) { found = index; break; }
      }
      if (found < 0) return undefined;
      lastPrerequisite = Math.max(lastPrerequisite, found);
    }
    const record = this.records.slice(lastPrerequisite + 1).reverse().find(item => item.stage === stage);
    if (!record || record.status !== "completed") return undefined;
    return schema.parse(record.data);
  }

  completedMatching<T extends z.ZodTypeAny>(stage: string, schema: T, predicate: (value: z.infer<T>) => boolean): z.infer<T> | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (record.stage !== stage || record.status !== "completed") continue;
      const value = schema.parse(record.data);
      if (predicate(value)) return value;
    }
    return undefined;
  }

  matching<T extends z.ZodTypeAny>(stage: string, schema: T, predicate: (value: z.infer<T>) => boolean): z.infer<T> | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (record.stage !== stage) continue;
      const value = schema.parse(record.data);
      if (predicate(value)) return value;
    }
    return undefined;
  }

  async record(stage: string, status: CheckpointStatus, data: unknown): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const records = [...this.records, { stage, status, at: new Date().toISOString(), data }];
      await this.save(records);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private async save(records: ChapterCheckpointRecord[]): Promise<void> {
    await commitAtomicFileSet({ rootDir: this.projectRoot, writes: [{
      relativePath: this.relativePath,
      content: `${JSON.stringify({ version: 1, operationId: this.operationId, bookId: this.bookId,
        chapterNumber: this.chapterNumber, records }, null, 2)}\n`,
    }] });
    this.records = records;
  }
}
