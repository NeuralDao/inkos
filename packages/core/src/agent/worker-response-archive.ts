import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { currentChapterStage } from "./chapter-stage-context.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

export interface WorkerResponseArchiveContext {
  readonly projectRoot: string;
  readonly workId?: string;
  readonly role: string;
  readonly requestFingerprint?: string;
  readonly requestSequence?: number;
  readonly resultTool?: string;
}

export interface WorkerResponseArchiveOutcome {
  readonly stage: "schema" | "domain";
  readonly status: "passed" | "failed";
  readonly code?: string;
  readonly message?: string;
}

function pathPart(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function rolePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "worker";
}

/** Save a raw assistant response before any caller or validator consumes it. */
export async function archiveWorkerResponse(input: {
  readonly context: WorkerResponseArchiveContext;
  readonly model: Model<Api>;
  readonly response: AssistantMessage | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown };
  readonly attempt: number;
}): Promise<string> {
  const workPath = pathPart(input.context.workId ?? "unbound-work");
  const directory = join(input.context.projectRoot, ".inkos", "agent-runs", workPath, "worker-responses");
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(directory, `${timestamp}-${rolePart(input.context.role)}-${randomUUID()}.json`);
  const chapterStage = currentChapterStage();
  const envelope = {
    schemaVersion: 1,
    receivedAt: new Date().toISOString(),
    workId: input.context.workId ?? null,
    agentRole: input.context.role,
    ...(chapterStage ? { chapterOperation: { operationId: chapterStage.operationId, bookId: chapterStage.bookId,
      chapterNumber: chapterStage.chapterNumber, stage: chapterStage.stage, attemptId: chapterStage.attemptId,
      requestSequence: input.context.requestSequence, requestFingerprint: input.context.requestFingerprint,
      resultTool: input.context.resultTool } } : {}),
    attempt: input.attempt,
    model: { id: input.model.id, provider: input.model.provider, api: input.model.api },
    validation: { status: "received_before_processing", stages: [] },
    response: input.response,
  };
  await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

/** Find a response for one previously started request without making a provider call. */
export async function findArchivedWorkerResponse(input: {
  readonly context: WorkerResponseArchiveContext;
  readonly operationId: string; readonly chapterNumber: number; readonly stage: string;
  readonly attemptId: string; readonly requestSequence: number; readonly requestFingerprint: string;
}): Promise<{ readonly path: string; readonly response: AssistantMessage } | undefined> {
  const directory = join(input.context.projectRoot, ".inkos", "agent-runs", pathPart(input.context.workId ?? "unbound-work"), "worker-responses");
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const matches: Array<{ path: string; response: AssistantMessage }> = [];
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const path = join(directory, file);
    let document: { schemaVersion?: unknown; workId?: unknown; agentRole?: unknown; chapterOperation?: Record<string, unknown>; response?: unknown };
    try { document = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    const operation = document.chapterOperation;
    if (!operation || document.schemaVersion !== 1 || document.workId !== input.context.workId || document.agentRole !== input.context.role
      || operation.bookId !== input.context.workId
      || operation.operationId !== input.operationId || operation.chapterNumber !== input.chapterNumber
      || operation.stage !== input.stage || operation.attemptId !== input.attemptId
      || operation.requestSequence !== input.requestSequence || operation.requestFingerprint !== input.requestFingerprint
      || operation.resultTool !== input.context.resultTool) continue;
    const response = document.response as Partial<AssistantMessage> | undefined;
    if (!response || response.role !== "assistant" || !Array.isArray(response.content) || !response.usage
      || typeof response.api !== "string" || typeof response.provider !== "string" || typeof response.model !== "string"
      || typeof response.timestamp !== "number" || !["stop", "length", "toolUse", "error", "aborted"].includes(response.stopReason ?? "")
      || ![response.usage.input, response.usage.output, response.usage.totalTokens].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      throw Object.assign(new Error("Archived chapter response is incomplete"), { code: "CHAPTER_RESUME_ARCHIVE_INVALID" });
    }
    matches.push({ path, response: response as AssistantMessage });
  }
  if (matches.length > 1) throw Object.assign(new Error("Multiple archived responses match the same chapter request"), { code: "CHAPTER_RESUME_ARCHIVE_AMBIGUOUS" });
  return matches[0];
}

/** Attach the host's validation result after the original response is durable. */
export async function markWorkerResponseArchive(path: string, outcome: WorkerResponseArchiveOutcome): Promise<void> {
  const document = JSON.parse(await readFile(path, "utf8")) as {
    validation?: { status?: string; stages?: WorkerResponseArchiveOutcome[] };
  };
  document.validation = { status: "checked", stages: [...(document.validation?.stages ?? []), outcome] };
  await commitAtomicFileSet({ rootDir: dirname(path), writes: [{ relativePath: basename(path), content: `${JSON.stringify(document, null, 2)}\n` }] });
}
