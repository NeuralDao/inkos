import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../agent/agent-tools.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";

describe("model-controlled file reads", () => {
  let root: string;
  let outside: string;
  const secret = "fixture-secret-sentinel";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-read-policy-"));
    outside = await mkdtemp(join(tmpdir(), "inkos-read-outside-"));
    await mkdir(join(root, ".inkos", "uploads"), { recursive: true });
    await mkdir(join(root, "works", "book", "source", "chapters"), { recursive: true });
    for (const path of [".env", ".env.local", ".env.bak", ".envrc", ".envrc.bak", ".envrc~", "inkos.json", "inkos.json.bak", ".inkos/secrets.json", ".inkos/secrets.json.bak"]) {
      await writeFile(join(root, path), secret);
    }
    await writeFile(join(root, "works/book/source/chapters/001.md"), "A harmless chapter.");
    await writeFile(join(root, ".inkos/uploads/source.txt"), "A harmless upload.");
    await writeFile(join(outside, "external.txt"), secret);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it.each([".env", ".env.local", ".env.bak", ".envrc", ".envrc.bak", ".envrc~", "inkos.json", "inkos.json.bak", ".inkos/secrets.json", ".inkos\\secrets.json.bak", "../outside.txt", "..\\outside.txt"])("denies a sensitive or escaping path: %s", async path => {
    const tool = createReadTool(root, { scope: "project" });
    const error = await tool.execute("read", { path }).catch(error => error);
    expect(error).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(error)).not.toContain(secret);
  });

  it("rejects absolute paths even when system reading is enabled", async () => {
    const tool = createReadTool(root, { scope: "project", allowSystemPaths: true });
    await expect(tool.execute("read", { path: join(outside, "external.txt") })).rejects.toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    await expect(tool.execute("read", { path: join(root, ".env") })).rejects.toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
  });

  it.each(["C:\\outside\\file.txt", "C:/outside/file.txt", "C:relative\\file.txt", "\\\\server\\share\\file.txt"])("rejects Windows path forms even when system reading is enabled: %s", async path => {
    const result = await createReadTool(root, { scope: "project", allowSystemPaths: true }).execute("read", { path }).catch(error => error);
    expect(result).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(result)).not.toContain(secret);
  });

  it("reads a normal chapter and a project upload", async () => {
    const tool = createReadTool(root, { scope: "project" });
    expect(JSON.stringify(await tool.execute("read", { path: "works/book/source/chapters/001.md" }))).toContain("A harmless chapter.");
    expect(JSON.stringify(await tool.execute("read", { path: ".inkos/uploads/source.txt" }))).toContain("A harmless upload.");
  });

  it("reads a chapter relative to the works scope", async () => {
    const tool = createReadTool(root, { scope: "works" });
    expect(JSON.stringify(await tool.execute("read", { path: "book/source/chapters/001.md" }))).toContain("A harmless chapter.");
  });

  it("rejects a file symlink to credentials", async context => {
    try { await symlink(join(root, ".inkos/secrets.json"), join(root, "harmless.txt"), "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    const result = await createReadTool(root, { scope: "project" }).execute("read", { path: "harmless.txt" }).catch(error => error);
    expect(result).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(result)).not.toContain(secret);
  });

  it("rejects an upload symlink to credentials", async context => {
    try { await symlink(join(root, ".inkos/secrets.json"), join(root, ".inkos/uploads/innocent.txt"), "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    const result = await createReadTool(root, { scope: "project" }).execute("read", { path: ".inkos/uploads/innocent.txt" }).catch(error => error);
    expect(result).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(result)).not.toContain(secret);
  });

  it("rejects a junction or directory symlink to an external directory", async context => {
    try { await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    const result = await createReadTool(root, { scope: "project" }).execute("read", { path: "linked/external.txt" }).catch(error => error);
    expect(result).toMatchObject({ code: "MODEL_FILE_ACCESS_DENIED" });
    expect(String(result)).not.toContain(secret);
  });

  it("reads a registered revision and still rejects a checksum mismatch", async () => {
    await saveWorkManifest(root, createWorkManifest({ id: "book", title: "Book", profileId: "longform-novel", language: "en" }));
    const work = await syncWorkSourceArtifacts({ projectRoot: root, workId: "book", accept: true, writes: [
      { relativePath: "works/book/source/chapters/001.md", content: "A registered chapter." },
    ] });
    const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.path === "source/chapters/001.md"))!;
    const revision = artifact.revisions.find(item => item.id === artifact.currentRevisionId)!;
    const tool = createReadTool(root, { workId: "book" });
    expect(JSON.stringify(await tool.execute("read", { artifactId: artifact.id }))).toContain("A registered chapter.");
    const path = join(root, "works", "book", revision.snapshotPath ?? revision.path);
    expect(await readFile(path, "utf8")).toBe("A registered chapter.");
    await writeFile(path, "Tampered chapter.");
    await expect(tool.execute("read", { artifactId: artifact.id })).rejects.toMatchObject({ code: "ARTIFACT_REVISION_CONFLICT" });
  });

  it("rejects a registered revision whose junction escapes the Work", async context => {
    await saveWorkManifest(root, createWorkManifest({ id: "book", title: "Book", profileId: "longform-novel", language: "en" }));
    const work = await syncWorkSourceArtifacts({ projectRoot: root, workId: "book", accept: true, writes: [
      { relativePath: "works/book/source/chapters/001.md", content: "A registered chapter." },
    ] });
    const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.path === "source/chapters/001.md"))!;
    try { await symlink(outside, join(root, "works/book/source/escape"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    await saveWorkManifest(root, { ...work, artifacts: work.artifacts.map(item => item.id !== artifact.id ? item : {
      ...item, revisions: item.revisions.map(revision => ({ ...revision, snapshotPath: "source/escape/external.txt" })),
    }) });
    const result = await createReadTool(root, { workId: "book" }).execute("read", { artifactId: artifact.id }).catch(error => error);
    expect(result).toMatchObject({ code: "ARTIFACT_PATH_OUTSIDE_WORK" });
    expect(String(result)).not.toContain(secret);
  });
});
