import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PipelineRunner } from "../pipeline/runner.js";
import { ComposerAgent } from "../agents/composer.js";
import { ReviserAgent } from "../agents/reviser.js";
import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("inkos-reviser-route-")) throw new Error("Unexpected fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

describe("Runner forwards narrative language independently to Reviser", () => {
  it.each([
    ["en", "ru", "ru"],
    ["en", undefined, "en"],
    ["zh", undefined, "zh"],
  ] as const)("routes operational %s / narrative %s with the matching length policy", async (language, narrativeLanguage, expectedNarrative) => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-route-"));
    roots.push(root);
    const book: BookConfig = {
      id: "city", title: "City", genre: "mystery", platform: "other", status: "active", language,
      ...(narrativeLanguage === undefined ? {} : { narrativeLanguage }),
      chapterWordCount: 2000, minChapterLength: 1500, maxChapterLength: 2500, targetChapters: 10,
      createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
    };
    const bookDir = join(root, "works", "city", "source");
    const snapshotDir = join(bookDir, "story", "snapshots", "0", "state");
    await mkdir(snapshotDir, { recursive: true });
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    const chapter = "# Chapter 1: Door\n\nProtected English. Старая фраза.\n";
    const index = [{ number: 1, title: "Door", wordCount: 3, createdAt: book.createdAt, updatedAt: book.updatedAt, observations: [], provenance: "generated" }];
    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify(book)),
      writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(index)),
      writeFile(join(bookDir, "chapters", "0001-door.md"), chapter),
      writeFile(join(bookDir, "story", "outline", "story_frame.md"), "A city mystery."),
      writeFile(join(bookDir, "story", "book_rules.md"), "Keep established facts."),
      writeFile(join(snapshotDir, "manifest.json"), JSON.stringify({ schemaVersion: 2, language, lastAppliedChapter: 0, projectionVersion: 1 })),
      writeFile(join(snapshotDir, "current_state.json"), JSON.stringify({ chapter: 0, facts: [] })),
      writeFile(join(snapshotDir, "hooks.json"), JSON.stringify({ hooks: [] })),
      writeFile(join(snapshotDir, "chapter_summaries.json"), JSON.stringify({ rows: [] })),
    ]);
    const context = vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockResolvedValue({ chapter: 1, selectedContext: [] });
    const stop = new Error("Stop at the Reviser boundary; no generation or settlement");
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockRejectedValue(stop);
    const runner = new PipelineRunner({ client: { defaults: { maxTokens: 8192 } } as unknown as LLMClient, model: "unused", projectRoot: root });
    await expect(runner.reviseDraft("city", 1, "spot-fix", "Revise only the selected phrase.", { targetText: "Старая фраза." }))
      .rejects.toBe(stop);
    expect(context).toHaveBeenCalledWith(expect.objectContaining({ language }));
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]![6]).toMatchObject({
      language, narrativeLanguage: expectedNarrative, targetText: "Старая фраза.", chapterTitle: "Door",
      lengthSpec: { target: 2000, minChapterLength: 1500, maxChapterLength: 2500, countingMode: narrativeLanguage === "ru" ? "ru_words" : language === "en" ? "en_words" : "zh_chars" },
    });
    expect(await readFile(join(bookDir, "chapters", "0001-door.md"), "utf8")).toBe(chapter);
  });
});
