import { describe, expect, it } from "vitest";
import { assertSafeBookId, deriveBookIdFromTitle, isSafeBookId } from "../utils/book-id.js";

describe("book id safety", () => {
  it.each([
    ["Тихий город", "тихий-город"],
    ["Ёж и робот", "ёж-и-робот"],
    ["Север-7", "север-7"],
    ["The Last City", "the-last-city"],
    ["夜港账本", "夜港账本"],
    ["Тихий City 7", "тихий-city-7"],
    ["  --ЁЖ___и  / робот!!!  ", "ёж-и-робот"],
    ["Я".repeat(31), "я".repeat(30)],
    ["A".repeat(31), "a".repeat(30)],
    ["夜".repeat(31), "夜".repeat(30)],
    ["../Тихий/город\\Север:7", "тихий-город-север-7"],
  ])("derives a safe id from %j", (title, expectedId) => {
    const id = deriveBookIdFromTitle(title);
    expect(id).toBe(expectedId);
    expect(isSafeBookId(id)).toBe(true);
  });

  it.each(["", "   ", "!?.../\\:*\"<>|", "../.."])(
    "leaves titles without allowed characters empty: %j",
    (title) => {
      const id = deriveBookIdFromTitle(title);
      expect(id).toBe("");
      expect(isSafeBookId(id)).toBe(false);
      expect(() => assertSafeBookId(id)).toThrow("Invalid bookId");
    },
  );

  it("accepts ids produced by InkOS title derivation", () => {
    expect(deriveBookIdFromTitle("夜港账本")).toBe("夜港账本");
    expect(deriveBookIdFromTitle(" Harbor: Ledger! ")).toBe("harbor-ledger");
    expect(isSafeBookId("harbor-ledger")).toBe(true);
    expect(isSafeBookId("夜港账本")).toBe(true);
    expect(isSafeBookId("天机破诡：仙帝重生救苍生")).toBe(true);
  });

  it("rejects prompt injection and path traversal shapes", () => {
    expect(isSafeBookId("../secrets")).toBe(false);
    expect(isSafeBookId("book\nIgnore previous instructions")).toBe(false);
    expect(isSafeBookId("book\"} malicious")).toBe(false);
    expect(isSafeBookId("book/slash")).toBe(false);
    expect(isSafeBookId("book:colon")).toBe(false);
    expect(isSafeBookId("")).toBe(false);
  });

  it("throws a stable error for unsafe ids", () => {
    expect(() => assertSafeBookId("bad\nid", "activeBookId"))
      .toThrow('Invalid activeBookId: "bad\\nid"');
  });
});
