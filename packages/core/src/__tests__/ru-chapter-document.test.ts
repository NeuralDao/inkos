import { describe, expect, it } from "vitest";
import { chapterDocumentBody, chapterDocumentHeading, renderChapterDocument } from "../utils/chapter-document.js";
import { readChapterHeading, splitChapters } from "../utils/chapter-splitter.js";
import { countChapterLength } from "../utils/length-metrics.js";

describe("Russian numbered chapter documents", () => {
  const title = "Обман RiverLine";
  const prose = "Глава в этом деле была одна.\r\n\r\nЁж проверил RiverLine и Apollo-1.\r\n";

  it("renders one Russian heading and preserves prose bytes across repeated rendering", () => {
    const wrapped = `# Chapter 1: ${title}\r\n\r\n## Глава 1: ${title}\r\n\r\n${prose}`;
    const document = renderChapterDocument(1, title, wrapped, "ru");
    expect(document).toBe(`# Глава 1: ${title}\n\n${prose}`);
    expect(renderChapterDocument(1, title, document, "ru")).toBe(document);
    expect(chapterDocumentBody(document, 1, title, "en")).toBe(prose);
    expect(chapterDocumentBody(document, 1, title, "ru")).toBe(prose);
    expect(countChapterLength(document, "ru_words")).toBe(countChapterLength(prose, "ru_words"));
  });

  it.each(["# Глава 1: Обман RiverLine", "ГЛАВА 1. Обман RiverLine", "## Глава 1 Обман RiverLine"])("reads %s", line => {
    expect(readChapterHeading(line)).toEqual({ number: 1, title, language: "ru" });
  });

  it.each(["Глава в этом деле была одна.", "Глава 1RiverLine", "# Глава в этом деле...", "Глава NASA"])("does not invent a chapter from %s", line => {
    expect(readChapterHeading(line)).toBeUndefined();
  });

  it("splits two chapters in order, folding only consecutive aliases with the same number", () => {
    const chapters = [
      { title, content: "Глава в этом деле была одна.\nRiverLine ждал ответа." },
      { title: "Последний рейс", content: "Ёж услышал гудок.\nРейс Apollo-1 уходил ночью." },
    ];
    const text = `# Chapter 1: ${title}\n\n# Глава 1: ${title}\n\n${chapters[0]!.content}\n\n# Глава 2: Последний рейс\n\n${chapters[1]!.content}`;
    expect(splitChapters(text)).toEqual(chapters);
    expect(splitChapters("Глава 1\n\nПервая.\n\nГлава 2\n\nВторая.").map(chapter => chapter.title)).toEqual(["Глава 1", "Глава 2"]);
  });

  it.each([
    ["en", "# Chapter 1: RiverLine", "Chapter II: Departure", "Departure"],
    ["zh", "# 第1章 RiverLine", "第二章 离港", "离港"],
  ] as const)("preserves %s rendering and parsing", (language, expected, heading, parsedTitle) => {
    expect(chapterDocumentHeading(1, "RiverLine", language)).toBe(expected);
    expect(readChapterHeading(heading)).toEqual({ number: 2, title: parsedTitle, language });
    expect(renderChapterDocument(1, "RiverLine", expected + "\n\nOriginal prose.", language)).toBe(expected + "\n\nOriginal prose.");
  });
});
