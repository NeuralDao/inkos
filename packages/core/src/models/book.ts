import { z } from "zod";
import { NarrativeLanguageSchema } from "../utils/book-language.js";

export const PlatformSchema = z.string().trim().min(1);
export type Platform = z.infer<typeof PlatformSchema>;

export const GenreSchema = z.string().min(1);
export type Genre = z.infer<typeof GenreSchema>;

export const BookStatusSchema = z.enum([
  "incubating",
  "outlining",
  "active",
  "paused",
  "completed",
  "dropped",
]);
export type BookStatus = z.infer<typeof BookStatusSchema>;

export const FanficModeSchema = z.string().trim().min(1);
export type FanficMode = z.infer<typeof FanficModeSchema>;

export const BookConfigSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && "narrativeLanguage" in value
    && value.narrativeLanguage === "ru" && !("language" in value && value.language !== undefined)) {
    return { ...value, language: "en" };
  }
  return value;
}, z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  platform: PlatformSchema,
  genre: GenreSchema,
  status: BookStatusSchema,
  targetChapters: z.number().int().min(1),
  chapterWordCount: z.number().int().min(1),
  minChapterLength: z.number().int().min(1).optional(),
  maxChapterLength: z.number().int().min(1).optional(),
  language: z.enum(["zh", "en"]),
  narrativeLanguage: NarrativeLanguageSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  parentBookId: z.string().optional(),
  fanficMode: FanficModeSchema.optional(),
}).strict().refine((book) => !(book.narrativeLanguage === "ru" && book.language === "zh"), {
  message: "Russian narrativeLanguage requires operational language en; zh + ru is not supported.",
  path: ["narrativeLanguage"],
}));

export type BookConfig = z.infer<typeof BookConfigSchema>;
