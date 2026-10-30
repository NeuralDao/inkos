import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviserAgent, type ReviseMode } from "../agents/reviser.js";
import { ChapterRewriteToolSchema } from "../agents/reviser-tool.js";
import { runWorkerAgentTool } from "../agent/worker-agent.js";
import type { LLMClient, LLMMessage } from "../llm/provider.js";
import type { AgentSkill } from "../skills/types.js";
import { loadBuiltinAgentSkills } from "../skills/builtin-loader.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { countChapterLength, buildLengthSpec } from "../utils/length-metrics.js";

// Only the transport is replaced: BaseAgent prepares real Skill/authorRequest messages,
// and the result-tool validation and range application still execute.
vi.mock("../agent/worker-agent.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent/worker-agent.js")>(),
  runWorkerAgentTool: vi.fn(),
}));

const modes: ReviseMode[] = ["polish", "rewrite", "rework", "anti-detect", "spot-fix"];
const modeRules: Record<ReviseMode, string> = {
  polish: "Edit wording only; keep facts, events, characters, and causality.",
  rewrite: "Rewrite the affected passages; rewrite the whole chapter only when the instruction spans it.",
  rework: "Scenes and conflict may be restructured within the supplied authority.",
  "anti-detect": "Change wording only while preserving story facts and causality.",
  "spot-fix": "Select only the source line ranges needed for the local request, then replace those ranges while preserving surrounding text.",
};
const contextPackage = { chapter: 1, selectedContext: [] };
const original = "Protected English NASA.\r\nСтарая строка.\r\nProtected Apollo-1 suffix.\n";
const replacement = "Элис надела Nike и открыла Microsoft. NASA готовила Apollo-1.\r\n";
const revised = "Элис прислушалась к дождю. В окне отражались мокрые крыши.";
const submissions: Array<{ name: string; messages: ReadonlyArray<LLMMessage>; parameters: TSchema }> = [];
let replies: Array<Record<string, unknown>>;
let skill: AgentSkill;

beforeAll(async () => {
  const available = await loadBuiltinAgentSkills();
  const found = available.skills.find(item => item.id === "inkos-long-writing");
  if (!found) throw new Error("The built-in long-writing Skill is required.");
  skill = found;
});
beforeEach(() => {
  submissions.length = 0;
  replies = [];
  vi.mocked(runWorkerAgentTool).mockImplementation(async (_client, _model, messages, tool, options) => {
    submissions.push({ name: tool.name, messages, parameters: tool.parameters });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected submission: ${tool.name}`);
    expect(Value.Check(tool.parameters, reply)).toBe(true);
    options?.onUsage?.({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return (tool.validate ? await tool.validate(reply as never) : reply) as never;
  });
});
afterEach(() => vi.clearAllMocks());

function agent() {
  const client = { defaults: { maxTokens: 16384 } } as unknown as LLMClient;
  return new ReviserAgent({ client, model: "unused", projectRoot: "", activatedSkills: [{ skill, resources: [] }] });
}
function expectRussianContract(mode: ReviseMode) {
  for (const call of submissions) {
    const text = call.messages.map(message => message.content).join("\n\n");
    expect(text).toContain(modeRules[mode]);
    expect(text).toContain("natural literary Russian (ru)");
    expect(text).toContain("submit_revised_chapter.revisedContent");
    expect(text).toContain("submit_chapter_range_replacements.range_N_content");
    expect(text).toContain("Nike, Microsoft, Apollo-1, NASA");
    expect(text).toContain("does not prohibit natural Russian rendering");
    expect(text).toContain("never authorizes a whole-chapter rewrite for a local request");
    expect(text).toContain("Preserve every source character outside those editable spans unchanged");
    expect(text).toContain("Do not apply this prose-language rule to submit_chapter_edit_ranges");
    expect(text).toContain(skill.body.trim());
    expect(text).toContain("## Observations or instruction");
    expect(text).not.toContain("## 观察或用户指令");
  }
}

describe("Reviser narrative language", () => {
  // Pure Agent prompt/scope tests omit the optional lengthSpec. The real
  // Runner length contract is not bypassed; its RU limitation is tested below.
  it.each(modes)("keeps English operations, Russian prose and the %s scope", async (mode) => {
    replies = mode === "spot-fix"
      ? [{ ranges: [{ startLine: 2, endLine: 2 }] }, { range_0_content: replacement }]
      : [{ revisedContent: revised }];
    const result = await agent().reviseChapter("unused", original, 1, [], mode, undefined, {
      language: "en", narrativeLanguage: "ru", contextPackage,
    });
    expectRussianContract(mode);
    if (mode === "spot-fix") {
      expect(submissions.map(call => call.name)).toEqual(["submit_chapter_edit_ranges", "submit_chapter_range_replacements"]);
      expect(result.revisedContent).toBe(`Protected English NASA.\r\n${replacement}Protected Apollo-1 suffix.\n`);
      expect(submissions[0]!.parameters.required).toEqual(["ranges"]);
      expect(submissions[1]!.parameters.required).toEqual(["range_0_content"]);
      expect(submissions[1]!.parameters.additionalProperties).toBe(false);
    } else {
      expect(submissions.map(call => call.name)).toEqual(["submit_revised_chapter"]);
      expect(submissions[0]!.parameters).toBe(ChapterRewriteToolSchema);
      expect(result.revisedContent).toBe(revised);
    }
  });

  it.each(modes)("binds exact targetText and preserves even same-line English outside it in %s", async (mode) => {
    const source = "English prefix: старая фраза — English suffix.\r\nNASA unchanged.\n";
    replies = [{ range_0_content: "Элис увидела Apollo-1" }];
    const result = await agent().reviseChapter("unused", source, 1, [], mode, undefined, {
      language: "en", narrativeLanguage: "ru", targetText: "старая фраза", contextPackage,
    });
    expect(submissions.map(call => call.name)).toEqual(["submit_chapter_range_replacements"]);
    expect(result.revisedContent).toBe("English prefix: Элис увидела Apollo-1 — English suffix.\r\nNASA unchanged.\n");
    expect(submissions[0]!.parameters.required).toEqual(["range_0_content"]);
    expect(submissions[0]!.parameters.additionalProperties).toBe(false);
    expectRussianContract(mode);
  });

  it("preserves disjoint protected passages and CRLF when two line ranges are selected", async () => {
    const source = "English start\r\nпервый\r\nEnglish middle\nвторой\nEnglish end";
    replies = [{ ranges: [{ startLine: 2, endLine: 2 }, { startLine: 4, endLine: 4 }] }, { range_0_content: "новый первый\r\n", range_1_content: "новый второй\n" }];
    const result = await agent().reviseChapter("unused", source, 1, [], "spot-fix", undefined, { language: "en", narrativeLanguage: "ru", contextPackage });
    expect(result.revisedContent).toBe("English start\r\nновый первый\r\nEnglish middle\nновый второй\nEnglish end");
    expect(submissions[1]!.parameters.required).toEqual(["range_0_content", "range_1_content"]);
  });

  it.each(["en", "zh"] as const)("retains the existing %s protocol when narrativeLanguage is omitted", async (language) => {
    replies = [{ revisedContent: "Existing prose remains valid." }];
    await agent().reviseChapter("unused", original, 1, [], "polish", undefined, { language, contextPackage });
    const system = submissions[0]!.messages.find(message => message.role === "system")!.content;
    const baseline = language === "en"
      ? `Revise with the activated professional Skill and governed context. ${modeRules.polish} Submit the result through the required tool.`
      : "按已激活的专业 Skill 和 governed context 修订。只改文字表面，保持事实、事件、人物和因果。通过指定结果工具提交。";
    expect(system.startsWith(baseline + "\n\n## Activated professional skills")).toBe(true);
    expect(system).not.toContain("## Revision narrative language");
  });

  it("retains the real Skill and non-conflicting authorRequest on both local submissions", async () => {
    const request = "Revise only the selected line in natural Russian. Preserve canon-consistent names and meaningful NASA terms; keep protected English unchanged.";
    replies = [{ ranges: [{ startLine: 2, endLine: 2 }] }, { range_0_content: replacement }];
    await withExecutionEvidence(() => {}, () => agent().reviseChapter("unused", original, 1, [], "spot-fix", undefined, {
      language: "en", narrativeLanguage: "ru", contextPackage,
    }), createBuiltInWorkProfileRegistry().require("longform-novel"), null, request);
    for (const call of submissions) {
      const effective = call.messages.map(message => message.content).join("\n\n");
      expect(effective).toContain(JSON.stringify({ authorRequest: request }));
      expect(effective).toContain(skill.body.trim());
      expect(effective).toContain("not author intent, canon, an output-format override");
    }
    expectRussianContract("spot-fix");
  });

  it("does not bypass the existing en_words rejection for pure Russian prose", async () => {
    expect(countChapterLength(revised, "en_words")).toBe(0);
    replies = [{ revisedContent: revised }];
    await expect(agent().reviseChapter("unused", original, 1, [], "rewrite", undefined, {
      language: "en", narrativeLanguage: "ru", contextPackage,
      lengthSpec: buildLengthSpec(20, "en", { minChapterLength: 10, maxChapterLength: 30 }),
    })).rejects.toMatchObject({ code: "CHAPTER_LENGTH_OUT_OF_RANGE" });
  });

  it.each(["ranges", "targetText"] as const)("keeps length validation active for Russian %s replacements", async (branch) => {
    replies = branch === "ranges"
      ? [{ ranges: [{ startLine: 2, endLine: 2 }] }, { range_0_content: revised + "\r\n" }]
      : [{ range_0_content: revised }];
    await expect(agent().reviseChapter("unused", original, 1, [], "spot-fix", undefined, {
      language: "en", narrativeLanguage: "ru", contextPackage,
      ...(branch === "targetText" ? { targetText: "Старая строка." } : {}),
      lengthSpec: buildLengthSpec(50, "en", { minChapterLength: 40, maxChapterLength: 60 }),
    })).rejects.toMatchObject({ code: "CHAPTER_LENGTH_OUT_OF_RANGE" });
  });

  it("keeps the full-rewrite result schema unchanged", () => {
    expect(Object.keys(ChapterRewriteToolSchema.properties)).toEqual(["revisedContent"]);
    expect(ChapterRewriteToolSchema.required).toEqual(["revisedContent"]);
    expect(ChapterRewriteToolSchema.properties.revisedContent).toMatchObject({ type: "string", minLength: 1, description: "Complete revised chapter prose." });
  });
});
