import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContinuationImportTool, createFanficBookTool, createImportChaptersTool, createIngestMaterialTool, createRetrieveMaterialTool } from "../agent/agent-tools.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";

describe("model material and chapter import boundaries", () => {
  let root: string;
  let outside: string;
  let pipeline: PipelineRunner;
  const secret = "SECRET_FIXTURE_SENTINEL";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-import-policy-"));
    outside = await mkdtemp(join(tmpdir(), "inkos-import-outside-"));
    await mkdir(join(root, ".inkos/uploads"), { recursive: true });
    await writeFile(join(root, ".inkos/secrets.json"), secret);
    await writeFile(join(root, "inkos.json"), secret);
    await writeFile(join(root, ".inkos/uploads/novel.txt"), "# Chapter 1: Arrival\n\nMira arrives at the quay.\n");
    await writeFile(join(outside, "external.txt"), secret);
    pipeline = new PipelineRunner({ projectRoot: root, model: "fixture", client: {} as never });
    await new StateManager(root).saveBookConfig("target", { id: "target", title: "Target", genre: "general", platform: "other", status: "active", targetChapters: 1, chapterWordCount: 100, language: "en", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it.each([".inkos/secrets.json", "inkos.json", "../external.txt"])("denies sensitive and escaping source %s before side effects", async path => {
    const ingest = createIngestMaterialTool(root);
    const importer = createImportChaptersTool(pipeline, "target", root);
    const fanfic = createFanficBookTool(pipeline, root);
    for (const operation of [
      () => ingest.execute("ingest", { sourceKind: "file", filePath: path }),
      () => importer.execute("import", { sourcePath: path }),
      () => createContinuationImportTool(pipeline, null, root).execute("continuation", { sourcePath: path, title: "New Book", language: "en" }),
      () => fanfic.execute("create", { title: "New Fanfic", sourcePath: path }),
    ]) {
      const error = await operation().catch(error => error);
      expect(error).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
      expect(String(error)).not.toContain(secret);
    }
    expect(await readdir(join(root, ".inkos"))).not.toContain("materials");
    expect(await readdir(join(root, "works"))).toEqual(["target"]);
  });

  it("rejects absolute model paths", async () => {
    const path = join(outside, "external.txt");
    await expect(createIngestMaterialTool(root).execute("ingest", { sourceKind: "file", filePath: path })).rejects.toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    await expect(createImportChaptersTool(pipeline, "target", root).execute("import", { sourcePath: path })).rejects.toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
  });

  it("ingests and retrieves a normal uploaded material", async () => {
    const ingest = await createIngestMaterialTool(root).execute("ingest", { sourceKind: "file", filePath: ".inkos/uploads/novel.txt" });
    expect(JSON.stringify(ingest)).toContain("materials");
    const result = await createRetrieveMaterialTool(root).execute("retrieve", { query: "Mira" });
    expect(JSON.stringify(result)).toContain("Mira arrives at the quay");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects a manifest that redirects its Markdown to a protected file", async () => {
    const dir = join(root, ".inkos/materials");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad.json"), JSON.stringify({ id: "bad", title: "Fixture", kind: "text", purpose: "reference", source: "fixture", mimeType: "text/plain", markdownPath: ".inkos/secrets.json", manifestPath: ".inkos/materials/bad.json", charCount: 1 }));
    const error = await createRetrieveMaterialTool(root).execute("retrieve", { query: "fixture" }).catch(error => error);
    expect(error).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(error)).not.toContain(secret);
  });

  it("rejects a source symlink to credentials", async context => {
    try { await symlink(join(root, ".inkos/secrets.json"), join(root, ".inkos/uploads/source.txt"), "file"); }
    catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip(); throw error; }
    const path = ".inkos/uploads/source.txt";
    for (const operation of [() => createIngestMaterialTool(root).execute("ingest", { sourceKind: "file", filePath: path }), () => createImportChaptersTool(pipeline, "target", root).execute("import", { sourcePath: path })]) {
      const error = await operation().catch(error => error);
      expect(error).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
      expect(String(error)).not.toContain(secret);
    }
    expect(await readdir(join(root, ".inkos"))).not.toContain("materials");
  });

  it("does not import a linked chapter in an uploaded directory", async context => {
    const dir = join(root, ".inkos/uploads/chapters");
    await mkdir(dir);
    await writeFile(join(dir, "001_scene.md"), "A safe scene.");
    try { await symlink(join(root, ".inkos/secrets.json"), join(dir, "002.txt"), "file"); }
    catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip(); throw error; }
    const imported = vi.spyOn(pipeline, "importChapters").mockImplementation(async input => ({ bookId: input.bookId, importedCount: input.chapters.length, totalWords: 3, nextChapter: 2 }));
    const result = await createImportChaptersTool(pipeline, "target", root).execute("import", { sourcePath: ".inkos/uploads/chapters" });
    expect(imported.mock.calls[0]![0].chapters).toEqual([{ title: "scene", content: "A safe scene." }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(imported.mock.calls)).not.toContain(secret);
  });

  it("rejects an archive Markdown symlink to credentials", async context => {
    const dir = join(root, ".inkos/materials");
    await mkdir(dir, { recursive: true });
    try { await symlink(join(root, ".inkos/secrets.json"), join(dir, "source.md"), "file"); }
    catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip(); throw error; }
    await writeFile(join(dir, "bad.json"), JSON.stringify({ id: "bad", title: "Fixture", kind: "text", purpose: "reference", source: "fixture", mimeType: "text/plain", markdownPath: ".inkos/materials/source.md", manifestPath: ".inkos/materials/bad.json", charCount: 1 }));
    const error = await createRetrieveMaterialTool(root).execute("retrieve", { query: "fixture" }).catch(error => error);
    expect(error).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(error)).not.toContain(secret);
  });

  it("imports uploaded chapters and an exact registered source", async () => {
    const imported = vi.spyOn(pipeline, "importChapters").mockImplementation(async input => ({ bookId: input.bookId, importedCount: input.chapters.length, totalWords: 5, nextChapter: 2 }));
    const tool = createImportChaptersTool(pipeline, "target", root);
    await tool.execute("upload", { sourcePath: ".inkos/uploads/novel.txt" });
    expect(imported.mock.calls[0]![0].chapters).toEqual([{ title: "Arrival", content: "Mira arrives at the quay." }]);
    await saveWorkManifest(root, createWorkManifest({ id: "source", title: "Source", profileId: "script", language: "en" }));
    await mkdir(join(root, "works/source/source"), { recursive: true });
    const work = await syncWorkSourceArtifacts({ projectRoot: root, workId: "source", accept: true, writes: [{ relativePath: "works/source/source/story.md", content: "# Chapter 1: Home\n\nMira returns home.\n" }] });
    const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.path === "source/story.md"))!;
    await tool.execute("artifact", { source: { workId: "source", artifactId: artifact.id } });
    expect(imported.mock.calls[1]![0].chapters).toEqual([{ title: "Home", content: "Mira returns home." }]);
  });
});
