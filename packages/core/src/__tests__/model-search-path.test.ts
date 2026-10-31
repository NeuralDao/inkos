import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool, createLsTool } from "../agent/agent-tools.js";

describe("model Work search and listing boundaries", () => {
  let root: string;
  let outside: string;
  const sentinel = "SECRET_FIXTURE_SENTINEL";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-search-policy-"));
    outside = await mkdtemp(join(tmpdir(), "inkos-search-external-"));
    await mkdir(join(root, "works/book/source/story/nested"), { recursive: true });
    await mkdir(join(root, "works/book/source/chapters"), { recursive: true });
    await mkdir(join(root, "works/other/source/story"), { recursive: true });
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, "works/book/source/story/one.md"), "First needle.\n");
    await writeFile(join(root, "works/book/source/story/nested/two.txt"), "Second NEEDLE.\n");
    await writeFile(join(root, "works/book/source/chapters/three.json"), '{"text":"Third needle."}');
    await writeFile(join(root, "works/book/source/story/.env.local.json"), sentinel);
    await writeFile(join(root, ".inkos/secrets.json"), sentinel);
    await writeFile(join(outside, "external.md"), sentinel);
    await writeFile(join(root, "works/other/source/story/other.md"), sentinel);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("searches normal and nested story and chapter files, excluding credentials", async () => {
    const grep = createGrepTool(root);
    const result = JSON.stringify(await grep.execute("grep", { bookId: "book", pattern: "needle" }));
    expect(result).toContain("story/one.md:1: First needle.");
    expect(result).toContain("story/nested/two.txt:1: Second NEEDLE.");
    expect(result).toContain("chapters/three.json:1:");
    expect(result).not.toContain(sentinel);
    const sensitive = JSON.stringify(await grep.execute("grep", { bookId: "book", pattern: sentinel }));
    expect(sensitive).not.toContain(sentinel);
  });

  it("lists normal files and directories with canonical paths and source prefix", async () => {
    const ls = createLsTool(root);
    const result = JSON.stringify(await ls.execute("ls", { bookId: "book", subdir: "source\\story" }));
    expect(result).toContain("works/book/source/story/one.md");
    expect(result).toContain("works/book/source/story/nested/");
    expect(result).not.toContain(".env.local.json");
    expect(result).not.toContain(sentinel);
    const nested = JSON.stringify(await ls.execute("ls", { bookId: "book", subdir: "story/nested" }));
    expect(nested).toContain("works/book/source/story/nested/two.txt");
  });

  it.each(["../other", "..\\other", "book/source", "C:book"])("rejects invalid Work identifier %s", async bookId => {
    for (const operation of [() => createGrepTool(root).execute("grep", { bookId, pattern: "needle" }), () => createLsTool(root).execute("ls", { bookId })]) {
      const error = await operation().catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it.each(["../..", "..\\..\\other", "story/../../../other", "C:\\outside", "\\\\server\\share"])("rejects escaping listing path %s", async subdir => {
    const error = await createLsTool(root).execute("ls", { bookId: "book", subdir }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sentinel);
  });

  it("handles missing story and chapters without an error", async () => {
    await mkdir(join(root, "works/empty/source"), { recursive: true });
    const result = JSON.stringify(await createGrepTool(root).execute("grep", { bookId: "empty", pattern: "needle" }));
    expect(result).toContain("No matches");
    expect(result).not.toContain(sentinel);
  });

  it("does not read or reveal a credential file symlink", async context => {
    try { await symlink(join(root, ".inkos/secrets.json"), join(root, "works/book/source/story/linked.json"), "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    const grep = JSON.stringify(await createGrepTool(root).execute("grep", { bookId: "book", pattern: sentinel }));
    const ls = JSON.stringify(await createLsTool(root).execute("ls", { bookId: "book", subdir: "story" }));
    expect(grep).not.toContain(sentinel);
    expect(ls).not.toContain(sentinel);
    expect(ls).not.toContain("linked.json");
  });

  for (const target of ["external", "other"] as const) it(`does not follow a directory link to ${target}`, async context => {
    const destination = target === "external" ? outside : join(root, "works/other/source/story");
    try { await symlink(destination, join(root, "works/book/source/story/linked"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    const grep = JSON.stringify(await createGrepTool(root).execute("grep", { bookId: "book", pattern: sentinel }));
    expect(grep).not.toContain(sentinel);
    const ls = JSON.stringify(await createLsTool(root).execute("ls", { bookId: "book", subdir: "story" }));
    expect(ls).not.toContain("linked");
    const error = await createLsTool(root).execute("ls", { bookId: "book", subdir: "story/linked" }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sentinel);
  });

  it("rejects a Work source linked to another Work", async context => {
    await mkdir(join(root, "works/alias"), { recursive: true });
    try { await symlink(join(root, "works/other/source"), join(root, "works/alias/source"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    for (const operation of [() => createGrepTool(root).execute("grep", { bookId: "alias", pattern: sentinel }), () => createLsTool(root).execute("ls", { bookId: "alias" })]) {
      const error = await operation().catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(sentinel);
    }
  });
});
