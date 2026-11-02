import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentChapterStage } from "../agent/chapter-stage-context.js";
import { ChapterCheckpoint } from "../pipeline/chapter-checkpoint.js";

describe("chapter checkpoints", () => {
  it("reuses request identities after an interruption and refuses changed inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-checkpoint-"));
    try {
      const initial = new ChapterCheckpoint(root, "book", 1);
      await initial.record("started", "completed", {});
      const fingerprint = "a".repeat(64);
      // Simulate an interrupted process: persist the request marker without recording a stage result.
      await initial.runStage("audit", async () => {
        expect(await currentChapterStage()!.beginRequest(fingerprint)).toEqual({ sequence: 1, replay: false });
      });
      const restored = await ChapterCheckpoint.latest(root, "book", 1);
      expect(restored?.hasStartedStage()).toBe(true);
      await restored!.runStage("audit", async () => {
        expect(await currentChapterStage()!.beginRequest(fingerprint)).toEqual({ sequence: 1, replay: true });
      }, true);
      await expect(restored!.runStage("audit", async () => {
        await currentChapterStage()!.beginRequest("b".repeat(64));
      }, true)).rejects.toMatchObject({ code: "CHAPTER_RESUME_INPUT_CHANGED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not mistake a failed or malformed stage for a successful one", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-checkpoint-"));
    try {
      const checkpoint = new ChapterCheckpoint(root, "book", 1);
      await checkpoint.record("audit", "failed", { message: "unavailable" });
      const { z } = await import("zod");
      expect(checkpoint.completed("audit", z.object({ content: z.string() }))).toBeUndefined();
      await checkpoint.record("audit", "completed", { content: 42 });
      expect(() => checkpoint.completed("audit", z.object({ content: z.string() }))).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous request in the same attempt instead of permitting another paid request", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-checkpoint-"));
    try {
      const checkpoint = new ChapterCheckpoint(root, "book", 2);
      const fingerprint = "c".repeat(64);
      await checkpoint.runStage("audit", async () => {
        await currentChapterStage()!.beginRequest(fingerprint);
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(checkpoint.runStage("audit", async () => {
          expect(await currentChapterStage()!.beginRequest(fingerprint)).toEqual({ sequence: 1, replay: true });
          throw Object.assign(new Error("Missing archived response"), { code: "CHAPTER_RESUME_AMBIGUOUS_STAGE" });
        }, true)).rejects.toMatchObject({ code: "CHAPTER_RESUME_AMBIGUOUS_STAGE" });
        expect(checkpoint.latestRecord("audit-error")).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits one fresh attempt after a recorded stage failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-checkpoint-"));
    try {
      const checkpoint = new ChapterCheckpoint(root, "book", 2);
      const fingerprint = "d".repeat(64);
      await expect(checkpoint.runStage("audit", async () => {
        await currentChapterStage()!.beginRequest(fingerprint);
        throw new Error("model failed");
      })).rejects.toThrow("model failed");
      expect(checkpoint.latestRecord("audit-error")?.status).toBe("failed");
      await checkpoint.runStage("audit", async () => {
        expect(await currentChapterStage()!.beginRequest(fingerprint)).toEqual({ sequence: 1, replay: false });
      }, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
