import { describe, expect, it } from "vitest";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "../agents/settler-prompts.js";
import type { BookConfig } from "../models/book.js";

describe("Settler narrative-language contract", () => {
  it("keeps operational instructions while requiring Russian readable state values", () => {
    const book: BookConfig = {
      id: "last-ledger",
      title: "Последняя ведомость",
      platform: "other",
      genre: "social thriller",
      status: "active",
      targetChapters: 5,
      chapterWordCount: 1350,
      language: "en",
      narrativeLanguage: "ru",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const system = buildSettlerSystemPrompt(book, null, "en", "ru");
    const user = buildSettlerUserPrompt({
      chapterNumber: 1,
      title: "Страница без подписи",
      content: "Ирина нашла страницу в архиве.",
      governedControlBlock: "## Chapter Control Inputs",
      language: "en",
      narrativeLanguage: "ru",
    });

    expect(system).toContain("Project explicit facts");
    expect(system).toContain("Write every human-readable text value in the runtime-state delta in Russian");
    expect(system).toContain("JSON keys, identifiers, chapter numbers, status/type enum values");
    expect(user).toContain("Project Chapter 1");
    expect(user).toContain("All human-readable text values in the structured state delta must be written in Russian");
  });
});
