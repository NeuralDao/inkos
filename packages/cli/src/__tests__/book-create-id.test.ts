import { afterEach, describe, expect, it, vi } from "vitest";
import { executeExplicitCapabilityTool, workDirectory } from "@actalk/inkos-core";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { bookCommand } from "../commands/book.js";
import { fanficCommand } from "../commands/fanfic.js";
import { logError } from "../utils.js";

vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  executeExplicitCapabilityTool: vi.fn(),
  workDirectory: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  stat: vi.fn(async () => ({ isDirectory: () => false })),
  readFile: vi.fn(async () => "Fixture source text"),
  mkdir: vi.fn(), rm: vi.fn(), writeFile: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  findProjectRoot: vi.fn(() => "unused-project"),
  loadConfig: vi.fn(async () => ({ language: "en" })),
  buildPipelineConfig: vi.fn(), resolveBookId: vi.fn(),
  resolveCliProfileSkills: vi.fn(), log: vi.fn(), logError: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("CLI title-derived book ids", () => {
  it.each([
    ["book create", bookCommand, ["create"]],
    ["fanfic init", fanficCommand, ["init", "--from", "fixture.txt"]],
  ] as const)("%s rejects punctuation before creating files or invoking production", async (_name, command, args) => {
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("CLI_EXIT"); });
    await expect(command.parseAsync([...args, "--title", "!!!"], { from: "user" }))
      .rejects.toThrow("CLI_EXIT");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining(
      "Book title must contain at least one supported letter or digit.",
    ));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(workDirectory).not.toHaveBeenCalled();
    expect(executeExplicitCapabilityTool).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });
});
