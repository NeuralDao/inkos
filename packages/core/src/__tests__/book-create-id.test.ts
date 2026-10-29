import { describe, expect, it, vi } from "vitest";
import { createBookFoundationTool } from "../harness/tools/longform-production.js";
import type { PipelineRunner } from "../pipeline/runner.js";

function mockPipeline() {
  const initBook = vi.fn(async () => {});
  const runWithAgentContext = vi.fn(async (_context: unknown, run: () => Promise<unknown>) => run());
  const pipeline = { initBook, runWithAgentContext } as unknown as PipelineRunner;
  return { pipeline, initBook, runWithAgentContext };
}

describe("create_book title-derived ids", () => {
  it.each(["params", "payload"] as const)("rejects punctuation in %s before starting the pipeline", async (source) => {
    const { pipeline, initBook, runWithAgentContext } = mockPipeline();
    const tool = createBookFoundationTool(pipeline, source === "payload"
      ? { actionPayload: { createBook: { title: "!!!" } } }
      : {});

    await expect(tool.execute("invalid-title", {
      instruction: "Create a book", title: source === "params" ? "!!!" : "Valid Title",
    })).rejects.toThrow("Book title must contain at least one supported letter or digit.");
    expect(runWithAgentContext).not.toHaveBeenCalled();
    expect(initBook).not.toHaveBeenCalled();
  });

  it.each([
    ["Тихий город", "тихий-город"],
    ["Ёж и робот", "ёж-и-робот"],
    ["The Last City", "the-last-city"],
    ["夜港账本", "夜港账本"],
  ])("preserves the title and derives the id for %j from params and payload", async (title, id) => {
    for (const source of ["params", "payload"] as const) {
      const { pipeline, initBook } = mockPipeline();
      const tool = createBookFoundationTool(pipeline, source === "payload"
        ? { actionPayload: { createBook: { title } } }
        : {});
      await tool.execute("valid-title", { instruction: "Create a book", title });
      expect(initBook).toHaveBeenCalledWith(expect.objectContaining({ id, title }), expect.anything());
    }
  });

  it("preserves an explicitly supplied safe id when no title-derived fallback is used", async () => {
    const { pipeline, initBook } = mockPipeline();
    await createBookFoundationTool(pipeline).execute("explicit-id", {
      instruction: "Create a book", title: "!!!", bookId: "existing-id",
    });
    expect(initBook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "existing-id", title: "!!!" }), expect.anything(),
    );
  });
});
