import type { ContextPackage } from "../models/input-governance.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";
import type { NarrativeLanguage } from "../utils/book-language.js";

export function getPlannerMemoSystemPrompt(
  language: "zh" | "en" = "zh",
  narrativeLanguage: NarrativeLanguage = language,
): string {
  const prompt = language === "en"
    ? "Compile the supplied governed context into one chapter memo. Do not write prose. Professional planning methodology comes only from the activated Skill. Preserve user direction and established facts, use only supplied hook ids, and submit one concrete goal plus a readable Markdown plan through the result tool."
    : "把输入的 governed context 编译为一份章节 memo，不写正文。专业规划方法只来自已激活 Skill。保留用户方向和既成事实，只使用输入中存在的 hook id，并通过结果工具提交一个具体目标和完整可读的 Markdown 计划。";
  if (narrativeLanguage !== "ru") return prompt;
  return `${prompt}\n\nLANGUAGE CONTRACT — AUTHOR-FACING PLAN: Write all natural-language text in both free-text fields (goal and body) entirely in Russian, including Markdown headings, labels, explanations, and summaries. This output-language requirement applies regardless of the language used by the user instruction, governed context, Skills, source excerpts, or previous chapter. Understand English or Chinese source material and express its relevant meaning in Russian; do not copy its wording as ordinary plan prose. Keep proper names, established non-Russian names, necessary exact quotations, technical terms, and identifiers in their established/original form where needed. Preserve threadRefs and all source identifiers exactly as supplied; never translate IDs, schema keys, enum values, or tool names. Before submitting, check both fields for accidental non-Russian prose and translate it while preserving the underlying facts and intent.`;
}

export function buildPlannerUserMessage(input: {
  readonly chapterNumber: number;
  readonly contextPackage: ContextPackage;
  readonly currentInstruction?: string;
  readonly previousChapter?: string;
  readonly lengthBudget: {
    readonly target: number;
    readonly unit: string;
  };
  readonly language?: "zh" | "en";
  readonly narrativeLanguage?: NarrativeLanguage;
}): string {
  const language = input.language ?? "zh";
  const context = renderNarrativeSelectedContext(input.contextPackage.selectedContext, language);
  const instruction = input.currentInstruction?.trim();
  const previous = input.previousChapter?.trim();
  if (language === "en") {
    return [
      `# Chapter ${input.chapterNumber} memo request`,
      instruction ? `## Current user instruction\n${instruction}` : "",
      `## Governed context\n${context}`,
      previous ? `## Previous chapter\n${previous}` : "",
      input.narrativeLanguage === "ru"
        ? "## Language of the author-facing plan\nWrite every natural-language part of goal and body in Russian, including Markdown headings and explanations. The source context may be English or Chinese; use it as evidence and express its meaning in Russian rather than copying its wording. Keep established names, necessary exact quotations, technical terms, and identifiers in their original form. Preserve threadRefs and source identifiers exactly as supplied. Before submitting, check for accidental English or Chinese prose."
        : "",
      "## Host length telemetry",
      `User target: ${input.lengthBudget.target} ${input.lengthBudget.unit}. Treat it as a creative constraint, not a host quality verdict.`,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `# 第${input.chapterNumber}章 memo 请求`,
    instruction ? `## 当前用户指令\n${instruction}` : "",
    `## 权威上下文\n${context}`,
    previous ? `## 上一章正文\n${previous}` : "",
    "## 宿主字数遥测",
    `用户目标：${input.lengthBudget.target} ${input.lengthBudget.unit}。这是创作约束，不是宿主质量判决。`,
  ].filter(Boolean).join("\n\n");
}
