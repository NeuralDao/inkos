import type { AuditResult } from "../agents/continuity.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ContextPackage } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { resolveNarrativeLanguage, type NarrativeLanguage } from "../utils/book-language.js";
import { usageFromError } from "./auto-revision-policy.js";
import { isChapterResumeSafetyError } from "../agent/chapter-stage-context.js";

export interface ChapterReviewUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewControlInput {
  readonly contextPackage: ContextPackage;
}

export interface ChapterReviewResult {
  readonly content: string;
  readonly wordCount: number;
  readonly review: AuditResult;
  readonly totalUsage: ChapterReviewUsage;
}

export async function reviewChapterDraft(params: {
  readonly book: { readonly genre: string; readonly language: "en" | "zh"; readonly narrativeLanguage?: NarrativeLanguage };
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly output: Pick<WriteChapterOutput, "content">;
  readonly controlInput: ChapterReviewControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewUsage;
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre: string | undefined,
      options: {
        readonly language: "zh" | "en";
        readonly narrativeLanguage?: NarrativeLanguage;
        readonly contextPackage: ContextPackage;
        readonly temperature?: number;
        readonly disableRetries?: boolean;
        readonly maxResultTurns?: number;
      },
    ) => Promise<AuditResult>;
  };
  readonly assertNotEmpty: (content: string) => void;
  readonly addUsage: (left: ChapterReviewUsage, right?: ChapterReviewUsage) => ChapterReviewUsage;
  readonly disableRetries?: boolean;
  readonly maxResultTurns?: number;
}): Promise<ChapterReviewResult> {
  const content = params.output.content;
  params.assertNotEmpty(content);
  const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
  const narrativeLanguage = resolveNarrativeLanguage(params.book);
  let modelReview: AuditResult;
  try {
    modelReview = await params.auditor.auditChapter(
      params.bookDir,
      content,
      params.chapterNumber,
      params.book.genre,
      {
        language: params.book.language,
        narrativeLanguage,
        contextPackage: params.controlInput.contextPackage,
        temperature: 0.3,
        ...(params.disableRetries ? { disableRetries: true } : {}),
        ...(params.maxResultTurns !== undefined ? { maxResultTurns: params.maxResultTurns } : {}),
      },
    );
  } catch (error) {
    if (isChapterResumeSafetyError(error)) throw error;
    const isEnglish = narrativeLanguage === "en";
    const isRussian = narrativeLanguage === "ru";
    const failedUsage = usageFromError(error);
    modelReview = {
      unavailable: true,
      ...(failedUsage ? { tokenUsage: failedUsage } : {}),
      observations: [{
        code: "review-unavailable",
        summary: isEnglish
          ? `Review observation was unavailable: ${String(error)}`
          : isRussian
            ? `Наблюдение аудитора недоступно: ${String(error)}`
            : `审稿观察暂不可用：${String(error)}`,
        evidence: [],
      }],
      summary: isEnglish ? "Review unavailable" : isRussian ? "Аудит недоступен" : "审稿暂不可用",
    };
  }
  return {
    content,
    wordCount,
    review: modelReview,
    totalUsage: params.addUsage(params.initialUsage, modelReview.tokenUsage),
  };
}
