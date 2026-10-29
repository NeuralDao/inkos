import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createBookFoundationTool, executeExplicitCapabilityTool } from "@actalk/inkos-core";
import { logError } from "../utils.js";

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  // Exercise current source without requiring a Core build at checkpoint G0.
  const languages = await vi.importActual<Pick<typeof import("@actalk/inkos-core"), "resolveBookCreationLanguages">>(
    "../../../core/src/utils/book-language.js",
  );
  const bookIds = await vi.importActual<Pick<typeof import("@actalk/inkos-core"), "deriveBookIdFromTitle">>(
    "../../../core/src/utils/book-id.js",
  );
  return {
    ...await importOriginal<typeof import("@actalk/inkos-core")>(),
    ...languages,
    deriveBookIdFromTitle: bookIds.deriveBookIdFromTitle,
    createBookFoundationTool: vi.fn(),
    executeExplicitCapabilityTool: vi.fn(async () => ({})),
    PipelineRunner: class {},
  };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
  mkdir: vi.fn(), rm: vi.fn(), writeFile: vi.fn(),
}));
vi.mock("../utils.js", () => ({
  findProjectRoot: vi.fn(() => "unused-project"),
  loadConfig: vi.fn(async () => ({ language: "zh" })),
  buildPipelineConfig: vi.fn(() => ({})), resolveBookId: vi.fn(),
  resolveCliProfileSkills: vi.fn(async () => []), log: vi.fn(), logError: vi.fn(),
}));
beforeEach(() => vi.resetModules());
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("book create narrative language", () => {
  it("passes Russian narrative and operational English through params and action payload", async () => {
    const { bookCommand } = await import("../commands/book.js");
    await bookCommand.parseAsync(["create", "--title", "Тихий город", "--narrative-lang", "ru"], { from: "user" });
    expect(createBookFoundationTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      language: "en", actionPayload: { createBook: expect.objectContaining({ language: "en", narrativeLanguage: "ru" }) },
    }));
    expect(executeExplicitCapabilityTool).toHaveBeenCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({ language: "en", narrativeLanguage: "ru" }),
    }));
  });
  it.each(["en", "zh"])("preserves explicit legacy --lang %s", async (language) => {
    const { bookCommand } = await import("../commands/book.js");
    await bookCommand.parseAsync(["create", "--title", "City", "--lang", language], { from: "user" });
    expect(executeExplicitCapabilityTool).toHaveBeenCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({ language }),
    }));
    const input = vi.mocked(executeExplicitCapabilityTool).mock.calls[0]![0];
    expect(input.parameters).not.toHaveProperty("narrativeLanguage");
  });
  it.each([
    ["--lang", "ru"], ["--lang", "unsupported"], ["--narrative-lang", "unsupported"],
    ["--lang", "zh", "--narrative-lang", "ru"],
  ])("rejects %j before filesystem operations or production", async (...options) => {
    const { bookCommand } = await import("../commands/book.js");
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("CLI_EXIT"); });
    await expect(bookCommand.parseAsync(["create", "--title", "City", ...options], { from: "user" })).rejects.toThrow("CLI_EXIT");
    expect(logError).toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(createBookFoundationTool).not.toHaveBeenCalled();
    expect(executeExplicitCapabilityTool).not.toHaveBeenCalled();
  });
});
