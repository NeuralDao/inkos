import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";

describe("Architect Russian runtime-state initialization", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("persists initial hook descriptions in Russian without changing operational metadata", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-architect-state-language-"));
    roots.push(bookDir);
    const architect = new ArchitectAgent({ client: {} as never, model: "fixture", projectRoot: bookDir });
    const output = {
      storyFrame: "Рамка истории.",
      volumeMap: "План глав.",
      bookRules: "Правила книги.",
      bookRulesData: { version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] },
      pendingHooks: "Начальные сюжетные крючки.",
      roles: [],
      initialHooks: [{
        hookId: "ledger-origin",
        startChapter: 0,
        type: "тайна происхождения",
        status: "deferred",
        lastAdvancedChapter: 0,
        expectedPayoff: "Выяснить, кто составил ведомость.",
        notes: "Завязка, заданная Архитектором.",
      }],
    } as ArchitectOutput;

    await architect.writeFoundationFiles(bookDir, output, "en", "init", "ru");

    const [hooks, manifest] = await Promise.all([
      readFile(join(bookDir, "story", "pending_hooks.md"), "utf-8"),
      readFile(join(bookDir, "story", "state", "manifest.json"), "utf-8"),
    ]);
    expect(hooks).toContain("# Сюжетные крючки");
    expect(hooks).toContain("Выяснить, кто составил ведомость.");
    expect(hooks).toContain("| deferred |");
    expect(JSON.parse(manifest).language).toBe("en");
  });
});
