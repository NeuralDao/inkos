import { describe, it, expect } from "vitest";
import {
  buildLengthSpec,
  countChapterLength,
  defaultChapterLength,
  assertChapterLength,
  chapterLengthDelivery,
  formatLengthCount,
  resolveLengthCountingMode,
} from "../utils/length-metrics.js";
import { LengthTelemetrySchema } from "../models/length-governance.js";

describe("length metrics", () => {
  it("counts Chinese chapter length using zh_chars", () => {
    expect(countChapterLength("他抬头看天。", "zh_chars")).toBe(6);
  });

  it("counts English chapter length using en_words", () => {
    expect(countChapterLength("He looked at the sky.", "en_words")).toBe(5);
  });

  it("defaults chapter length to the language-native unit", () => {
    expect(defaultChapterLength("zh")).toBe(3000);
    expect(defaultChapterLength("en")).toBe(2000);
    expect(defaultChapterLength()).toBe(3000);
  });

  it("counts prose only for markdown-shaped Chinese chapters", () => {
    const markdownChapter = [
      "---",
      "title: 第1章 归来",
      "---",
      "",
      "# 第1章 归来",
      "",
      "陈风抬头看天。",
    ].join("\n");

    expect(countChapterLength(markdownChapter, "zh_chars")).toBe("陈风抬头看天。".length);
  });

  it("keeps only the user's target and language-native counting mode", () => {
    const spec = buildLengthSpec(2200, "zh");

    expect(spec).toEqual({
      target: 2200,
      countingMode: "zh_chars",
    });
    expect(buildLengthSpec(2200, "en")).toEqual({
      target: 2200,
      countingMode: "en_words",
    });
  });
});

describe("Russian prose length", () => {
  it.each([
    ["Ёж и ёлка. ЁЖ увидел NASA, Nike и Microsoft.", 9],
    ["научно-фантастический кто-то Apollo-1 Ту‑154 don't O’Neill", 6],
    ["слово—слово слово – слово 2026 7Б Б-52", 7],
    ["первая\r\nвторая\nтретья\tfourth", 4],
    ["cafe\u0301 е\u0308лка", 2],
    ["... — !!! ___", 0],
    ["", 0],
    ["夜港账本", 0],
    ["3.14 10/20 1_2", 6],
  ])("counts %j as %i ru_words", (text, expected) => {
    expect(countChapterLength(text, "ru_words")).toBe(expected);
  });

  it("excludes BOM/frontmatter, ATX/Setext headings and fenced code with matching markers", () => {
    const markdown = [
      "\uFEFF---", "title: Скрытое название", "---", "# Скрытый заголовок",
      "Ещё заголовок", "===", "Подзаголовок", "---",
      "Ёж встретил NASA.", "````ts", "не художественный текст", "```", "всё ещё код", "````",
      "~~~", "другой код", "```", "всё ещё код", "~~~", "Apollo-1 вернулся.",
    ].join("\r\n");
    expect(countChapterLength(markdown, "ru_words")).toBe(5);
  });

  it("preserves legacy English/Chinese semantics and selects RU only explicitly", () => {
    expect(countChapterLength("Ёж Apollo-1 don't NASA", "en_words")).toBe(4);
    expect(countChapterLength("Ёж Apollo-1", "zh_chars")).toBe("ЁжApollo-1".length);
    expect(resolveLengthCountingMode("en", "ru")).toBe("ru_words");
    expect(resolveLengthCountingMode("en", "zh")).toBe("en_words");
    expect(resolveLengthCountingMode("zh", "en")).toBe("zh_chars");
    expect(buildLengthSpec(5, "en", { narrativeLanguage: "ru", minChapterLength: 3, maxChapterLength: 7 }))
      .toEqual({ target: 5, countingMode: "ru_words", minChapterLength: 3, maxChapterLength: 7 });
    expect(formatLengthCount(5, "ru_words")).toBe("5 words");
  });

  it("keeps explicit RU bounds hard and telemetry round-trippable", () => {
    const spec = buildLengthSpec(3, "en", { narrativeLanguage: "ru", minChapterLength: 2, maxChapterLength: 4 });
    expect(() => assertChapterLength("Ёж увидел Apollo-1.", spec)).not.toThrow();
    for (const content of ["Ёж", "Ёж увидел корабль у старой пристани."]) {
      expect(() => assertChapterLength(content, spec)).toThrow("CHAPTER_LENGTH_OUT_OF_RANGE");
      expect(chapterLengthDelivery(countChapterLength(content, "ru_words"), spec)?.status).toBe("needs_revision");
    }
    expect(LengthTelemetrySchema.parse(JSON.parse(JSON.stringify({
      target: 3, countingMode: "ru_words", writerCount: 3, postReviseCount: 3, finalCount: 3, repairApplied: false,
    })))).toMatchObject({ countingMode: "ru_words", finalCount: 3 });
  });
});
