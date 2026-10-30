import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import JSZip from "jszip";
import { Value } from "@sinclair/typebox/value";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import { loadChaptersFromPath } from "../agent/chapter-import-source.js";
import { WriterAgent } from "../agents/writer.js";
import { ComposerAgent } from "../agents/composer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { syncChapterWordCounts } from "../state/chapter-word-sync.js";
import { buildExportArtifact } from "../interaction/export-artifact.js";
import { chapterDocumentBody, renderChapterDocument } from "../utils/chapter-document.js";
import { readChapterHeading } from "../utils/chapter-splitter.js";
import { countChapterLength } from "../utils/length-metrics.js";

// No network: only model decisions are fixtures. Reader/writer, range/schema
// normalization, Runner, reducer, persistence, export and ZIP generation are real.
vi.mock("../agent/worker-agent.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent/worker-agent.js")>(),
  runWorkerAgentTool: vi.fn(),
}));

const source = [
  { title: "Обман RiverLine", content: "Глава в этом деле была одна.\n\n## След на воде\n\nЁж проверил RiverLine и Apollo-1." },
  { title: "Последний рейс", content: "NASA ответила ночью.\n\nRiverLine отправил последний рейс." },
];
const roots: string[] = [];
let nextRevision = "";
const client = { defaults: { maxTokens: 16384 } } as unknown as LLMClient;

beforeEach(() => {
  vi.mocked(runWorkerAgentTool).mockImplementation(async (_client, _model, _messages, tool, options) => {
    const reply = tool.name === "submit_revised_chapter" ? { revisedContent: nextRevision }
      : tool.name === "submit_runtime_state_delta" ? {
        postSettlement: "The ferry departs.", factOps: { upsert: [], expire: [] },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { title: "Ferry", characters: "visitor", events: "Departure", stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "departure" },
      } : undefined;
    if (!reply) throw new Error(`Unexpected model operation: ${tool.name}`);
    expect(Value.Check(tool.parameters, reply)).toBe(true);
    options?.onUsage?.({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return (tool.validate ? await tool.validate(reply as never) : reply) as never;
  });
  vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockImplementation(async input => ({ chapter: input.chapterNumber, selectedContext: [] }));
  vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({ observations: [], summary: "Reviewed." });
  vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ consistent: true, reconciliationRequired: false, observations: [] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("inkos-ru-export-")) throw new Error("Unexpected fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(language: "en" | "zh" = "en", narrativeLanguage?: "ru", id = "river") {
  const root = await mkdtemp(join(tmpdir(), "inkos-ru-export-"));
  roots.push(root);
  const state = new StateManager(root);
  const book: BookConfig = { id, title: "Речная история", genre: "general", platform: "other", status: "active", language,
    ...(narrativeLanguage ? { narrativeLanguage } : {}), targetChapters: 2, chapterWordCount: 12, minChapterLength: 4, maxChapterLength: 30,
    createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" };
  await state.saveBookConfig(id, book);
  const bookDir = state.bookDir(id);
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  await writeFile(join(bookDir, "story", "outline", "story_frame.md"), "Two ferries depart.");
  await writeFile(join(bookDir, "story", "outline", "volume_map.md"), "Two chapters.");
  await writeFile(join(bookDir, "story", "book_rules.md"), "Preserve canon.");
  await writeFile(join(bookDir, "story", "book_rules.json"), JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }));
  await createInitialRuntimeState({ bookDir, language });
  await state.saveChapterIndex(id, []);
  await state.snapshotState(id, 0);
  return { root, state, book, bookDir, runner: new PipelineRunner({ projectRoot: root, client, model: "unused" }) };
}

async function chapterFiles(bookDir: string) {
  return (await readdir(join(bookDir, "chapters"))).filter(name => name.endsWith(".md")).sort();
}

function decodeXmlEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|amp|lt|gt|quot|apos);/g, (_entity, value: string) => {
    if (!value.startsWith("#")) return named[value]!;
    const hex = /^#x/i.test(value);
    return String.fromCodePoint(parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

async function epubContents(payload: string | Buffer) {
  expect(Buffer.isBuffer(payload)).toBe(true);
  const zip = await JSZip.loadAsync(payload);
  const opfFile = Object.keys(zip.files).find(path => path.endsWith(".opf"))!;
  const opf = await zip.file(opfFile)!.async("string");
  const base = opfFile.slice(0, opfFile.lastIndexOf("/") + 1);
  const manifest = new Map([...opf.matchAll(/<item\s+([^>]+)>/g)].map(match => {
    const id = /\bid="([^"]+)"/.exec(match[1]!)?.[1];
    const href = /\bhref="([^"]+)"/.exec(match[1]!)?.[1];
    return [id, href] as const;
  }));
  const spine = [...opf.matchAll(/<itemref\s+[^>]*idref="([^"]+)"/g)].map(match => manifest.get(match[1]));
  const xhtml = await Promise.all(spine.filter((href): href is string => !!href).map(href => zip.file(base + href)!.async("string")));
  return { zip, opf, xhtml };
}

describe("Russian chapter headings and reader exports", () => {
  it("round-trips two chapters through save/read/revision/MD/TXT while EPUB retains Russian metadata, headings and prose", async () => {
    const { root, state, book, bookDir, runner } = await fixture("en", "ru");
    // Import supplied documents with old English and repeated Russian wrappers.
    await runner.importChapters({ bookId: book.id, resumeFrom: 1, chapters: source.map((chapter, index) => ({
      title: chapter.title, content: `# Chapter ${index + 1}: ${chapter.title}\n\n# Глава ${index + 1}: ${chapter.title}\n\n${chapter.content}`,
    })) });
    const files = await chapterFiles(bookDir);
    expect(files).toHaveLength(2);
    const writer = new WriterAgent({ projectRoot: root, client, model: "unused" });
    for (const [index, file] of files.entries()) {
      const number = index + 1, chapter = source[index]!;
      const raw = await readFile(join(bookDir, "chapters", file), "utf8");
      expect(raw).toBe(renderChapterDocument(number, chapter.title, chapter.content, "ru"));
      expect(raw.split("\n").filter(line => readChapterHeading(line))).toHaveLength(1);
      expect(await loadChaptersFromPath(join(bookDir, "chapters", file))).toEqual([chapter]);
      const settled = await writer.settleChapterState({ book, bookDir, chapterNumber: number, baselineChapter: number - 1,
        title: chapter.title, content: raw, chapterIntent: "Preserve the prose.", contextPackage: { chapter: number, selectedContext: [] } });
      await writer.saveChapter(bookDir, settled, book.language, await state.loadChapterIndex(book.id), book.narrativeLanguage);
      expect(await readFile(join(bookDir, "chapters", file), "utf8")).toBe(raw);
      // Exercise both the older-chapter branch and the latest-chapter branch.
      nextRevision = `# Chapter ${number}: ${chapter.title}\n\n# Глава ${number}: ${chapter.title}\n\n${chapter.content}`;
      const revision = await runner.reviseDraft(book.id, number, "polish", "Preserve the supplied prose and title exactly.");
      expect(revision.wordCount).toBe(countChapterLength(chapter.content, "ru_words"));
      expect(revision.lengthTelemetry).toMatchObject({ countingMode: "ru_words", finalCount: revision.wordCount });
      expect(await readFile(join(bookDir, "chapters", file), "utf8")).toBe(raw);
    }
    expect(await loadChaptersFromPath(join(bookDir, "chapters"))).toEqual(source);
    expect(await syncChapterWordCounts(state, book.id)).toMatchObject({ countingMode: "ru_words", changes: [] });
    const exportedIndex = await state.loadChapterIndex(book.id);
    expect(exportedIndex.map(chapter => chapter.title)).toEqual(source.map(chapter => chapter.title));
    for (const format of ["md", "txt"] as const) {
      const artifact = await buildExportArtifact(state, book.id, { format });
      expect(artifact.chaptersExported).toBe(2);
      const text = String(artifact.payload);
      expect(text.split("\n").filter(line => readChapterHeading(line))).toHaveLength(2);
      const path = join(root, "roundtrip." + format);
      await writeFile(path, artifact.payload);
      expect(await loadChaptersFromPath(path)).toEqual(source);
      // Re-import through the real pipeline into a separate RU Work.
      const target = await fixture("en", "ru", "reimport-" + format);
      await target.runner.importChapters({ bookId: target.book.id, resumeFrom: 1, chapters: await loadChaptersFromPath(path) });
      expect(await loadChaptersFromPath(join(target.bookDir, "chapters"))).toEqual(source);
      expect((await target.state.loadChapterIndex(target.book.id)).map(chapter => chapter.wordCount))
        .toEqual(source.map(chapter => countChapterLength(chapter.content, "ru_words")));
    }
    const artifact = await buildExportArtifact(state, book.id, { format: "epub" });
    expect(artifact.chaptersExported).toBe(2);
    const { zip, opf, xhtml } = await epubContents(artifact.payload);
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");
    expect(opf).toMatch(/<dc:language>ru<\/dc:language>/);
    const headings = (html: string) => [...html.matchAll(/<h1>(.*?)<\/h1>/gs)].map(match => decodeXmlEntities(match[1]!));
    const chapters = xhtml.filter(html => headings(html).some(title => /^Глава \d+:/.test(title)));
    expect(chapters).toHaveLength(2);
    for (const [index, html] of chapters.entries()) {
      expect(html).toContain('lang="ru"');
      expect(html).toContain('xml:lang="ru"');
      expect(headings(html)).toEqual([`Глава ${index + 1}: ${source[index]!.title}`]);
      const paragraphs = [...html.matchAll(/<p>(.*?)<\/p>/gs)].map(match => decodeXmlEntities(match[1]!));
      expect(paragraphs).toEqual(source[index]!.content.split("\n").filter(Boolean));
    }
    const nav = xhtml.find(html => html.includes('id="toc"'))!;
    const navTitles = [...nav.matchAll(/<a\b[^>]*>(.*?)<\/a>/gs)]
      .map(match => decodeXmlEntities(match[1]!.replace(/<[^>]*>/g, "")).trim());
    expect(navTitles).toEqual(source.map((chapter, index) => `Глава ${index + 1}: ${chapter.title}`));
    expect((await loadRuntimeStateSnapshot(bookDir)).manifest.language).toBe("en");
    for (const call of vi.mocked(ContinuityAuditor.prototype.auditChapter).mock.calls) expect(call[4]?.language).toBe("en");
    for (const call of vi.mocked(StateValidatorAgent.prototype.validate).mock.calls) expect(call[6]).toBe("en");
  }, 30000);

  it.each(["en", "zh"] as const)("preserves %s headings, text roundtrip and EPUB language", async language => {
    const { root, state, book, bookDir, runner } = await fixture(language);
    const chapters = language === "en" ? [{ title: "RiverLine", content: "The ferry arrives." }, { title: "Departure", content: "The ferry leaves." }]
      : [{ title: "RiverLine", content: "渡船进港。" }, { title: "离港", content: "渡船离港。" }];
    await runner.importChapters({ bookId: book.id, resumeFrom: 1, chapters });
    const files = await chapterFiles(bookDir);
    for (const [index, file] of files.entries()) expect(await readFile(join(bookDir, "chapters", file), "utf8"))
      .toBe(renderChapterDocument(index + 1, chapters[index]!.title, chapters[index]!.content, language));
    for (const format of ["md", "txt"] as const) {
      const artifact = await buildExportArtifact(state, book.id, { format });
      const path = join(root, "regression." + format);
      await writeFile(path, artifact.payload);
      expect(await loadChaptersFromPath(path)).toEqual(chapters);
    }
    const { opf, xhtml } = await epubContents((await buildExportArtifact(state, book.id, { format: "epub" })).payload);
    expect(opf).toContain(`<dc:language>${language === "en" ? "en" : "zh-CN"}</dc:language>`);
    expect(xhtml.join("\n")).toContain(language === "en" ? "Chapter 1: RiverLine" : "第1章 RiverLine");
  }, 30000);

  it("normalizes old English wrappers only in the exported RU copy", async () => {
    const { root, state, book, bookDir, runner } = await fixture("en", "ru");
    await runner.importChapters({ bookId: book.id, resumeFrom: 1, chapters: source });
    const [firstFile] = await chapterFiles(bookDir);
    const path = join(bookDir, "chapters", firstFile!);
    const old = `# Chapter 1: ${source[0]!.title}\n\n# Глава 1: ${source[0]!.title}\n\n${source[0]!.content}`;
    await writeFile(path, old);
    for (const format of ["md", "txt"] as const) {
      const artifact = await buildExportArtifact(state, book.id, { format });
      expect(String(artifact.payload).split("\n").filter(line => readChapterHeading(line))).toHaveLength(2);
      const delivery = join(root, "normalized." + format);
      await writeFile(delivery, artifact.payload);
      expect(await loadChaptersFromPath(delivery)).toEqual(source);
      expect(await readFile(path, "utf8")).toBe(old);
    }
  }, 30000);
});
