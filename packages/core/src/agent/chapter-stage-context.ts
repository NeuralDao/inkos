import { AsyncLocalStorage } from "node:async_hooks";

export interface ChapterStageContext {
  readonly operationId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly stage: string;
  readonly attemptId: string;
  readonly beginRequest: (fingerprint: string) => Promise<{ readonly sequence: number; readonly replay: boolean }>;
}

const storage = new AsyncLocalStorage<ChapterStageContext>();

export function withChapterStage<T>(context: ChapterStageContext, task: () => Promise<T>): Promise<T> {
  return storage.run(context, task);
}

export function currentChapterStage(): ChapterStageContext | undefined {
  return storage.getStore();
}

/** These errors mean the host cannot safely decide whether a request may be repeated. */
export function isChapterResumeSafetyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("CHAPTER_RESUME_") || code === "CHAPTER_RESPONSE_ARCHIVE_REQUIRED");
}
