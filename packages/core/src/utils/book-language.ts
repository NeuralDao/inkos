import { z } from "zod";

export const BookLanguageSchema = z.enum(["en", "zh"]);
export const NarrativeLanguageSchema = z.enum(["en", "zh", "ru"]);
export type NarrativeLanguage = z.infer<typeof NarrativeLanguageSchema>;

export function resolveBookCreationLanguages(
  input: { readonly language?: unknown; readonly narrativeLanguage?: unknown },
  fallbackLanguage: unknown = "zh",
): { language: "en" | "zh"; narrativeLanguage?: NarrativeLanguage } {
  const explicitLanguage = BookLanguageSchema.optional().parse(input.language);
  const narrativeLanguage = NarrativeLanguageSchema.optional().parse(input.narrativeLanguage);
  if (narrativeLanguage === "ru" && explicitLanguage === "zh") {
    throw new Error("Russian narrativeLanguage requires operational language en; zh + ru is not supported.");
  }
  const language = explicitLanguage ?? (narrativeLanguage === "ru" ? "en" : BookLanguageSchema.parse(fallbackLanguage));
  return { language, ...(narrativeLanguage !== undefined ? { narrativeLanguage } : {}) };
}

export function resolveNarrativeLanguage(book: {
  readonly language: "en" | "zh";
  readonly narrativeLanguage?: NarrativeLanguage;
}): NarrativeLanguage {
  const resolved = resolveBookCreationLanguages(book);
  return resolved.narrativeLanguage ?? resolved.language;
}
