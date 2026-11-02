import { describe, expect, it } from "vitest";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { buildHarnessSystemPrompt } from "../harness/system-prompt.js";

describe("unbound Work creation guidance", () => {
  it("routes a long-form session directly to its book creation action", () => {
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    const prompt = buildHarnessSystemPrompt({ profile, work: null, language: "en" });

    expect(prompt).toContain("invoke longform__create_book directly");
    expect(prompt).toContain("Do not call workspace__list_work_profiles or workspace__create_work first");
  });

  it("keeps profile selection for the general workspace", () => {
    const profile = createBuiltInWorkProfileRegistry().require("workspace-default");
    const prompt = buildHarnessSystemPrompt({ profile, work: null, language: "en" });

    expect(prompt).toContain("choose an installed profile with workspace__list_work_profiles");
    expect(prompt).toContain("invoke workspace__create_work");
  });
});
