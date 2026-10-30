import { beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";
import type { AgentSkill } from "../skills/types.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "../agents/settler-prompts.js";
import { ChapterDraftToolSchema } from "../agents/writer-tool.js";
import { prepareWorkerMessages } from "../agents/base.js";
import { loadBuiltinAgentSkills } from "../skills/builtin-loader.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";

const baseBook: BookConfig = {
  id: "city", title: "City", genre: "mystery", platform: "other", status: "active",
  language: "en", chapterWordCount: 2000, targetChapters: 10,
  createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
};
const combinations = [
  ["en", "ru", "Russian"],
  ["en", "zh", "Chinese"],
  ["zh", "en", "English"],
  ["en", "en", "English"],
  ["zh", "zh", "Chinese"],
] as const;

describe("Writer chapter draft language", () => {
  it.each(combinations)("targets %s/%s title and content", (language, narrativeLanguage, target) => {
    const prompt = buildWriterSystemPrompt({ ...baseBook, language, narrativeLanguage }, null, "", "");
    expect(prompt).toContain(`For submit_chapter_draft only: write the generated title and the narrative prose in content in ${target} (${narrativeLanguage})`);
    expect(prompt).toContain("independently of the operational language");
    expect(prompt).toContain("not to state settlement or other operational outputs");
    expect(prompt).toContain(language === "en" ? "## Authority" : "## 权威顺序");
  });

  it.each(["en", "zh"] as const)("inherits %s for a book without narrativeLanguage", (language) => {
    const implicit = buildWriterSystemPrompt({ ...baseBook, language }, null, "", "");
    const explicit = buildWriterSystemPrompt({ ...baseBook, language, narrativeLanguage: language }, null, "", "");
    expect(implicit).toBe(explicit);
  });

  it("does not let the operational prompt override change the narrative target", () => {
    const prompt = buildWriterSystemPrompt({ ...baseBook, narrativeLanguage: "ru" }, null, "", "", "zh");
    expect(prompt).toContain("## 权威顺序");
    expect(prompt).toContain("content in Russian (ru)");
  });

  it("preserves exact author titles and canon spellings without locking internal-plan English into prose", () => {
    const prompt = buildWriterSystemPrompt({ ...baseBook, narrativeLanguage: "ru" }, null, "", "");
    expect(prompt).toContain("Preserve a chapter title explicitly specified by the author as exact verbatim, even if it is in another language.");
    expect(prompt).toContain("Preserve canon-established spellings of names and terms, and quotations explicitly required to be reproduced verbatim.");
    expect(prompt).toContain("Use the target narrative language and canon-consistent terminology.");
    expect(prompt).toContain("An English name or term in internal plans alone does not prohibit natural Russian rendering or translation/transliteration into the target narrative language.");
    expect(prompt).toContain("Latin and other scripts are allowed when meaningful or explicitly requested by the author.");
    expect(prompt).not.toContain("Do not translate or transliterate them merely to match the narrative language.");
    expect(prompt).toContain("Keep IDs, JSON keys, tool names, the result schema, and operational materials unchanged.");
    expect(Value.Check(ChapterDraftToolSchema, { title: "The Last Door", content: "Элис прочла записку: ‘Keep going’. На панели мигал API." })).toBe(true);
  });

  it.each(["en", "zh"] as const)("does not add the prose contract to %s settlement prompts", (language) => {
    const operational = { ...baseBook, language };
    const differentNarrative = { ...operational, narrativeLanguage: language === "en" ? "ru" as const : "en" as const };
    const prompt = buildSettlerSystemPrompt(differentNarrative, null, language);
    expect(prompt).toBe(buildSettlerSystemPrompt(operational, null, language));
    expect(prompt).not.toContain("## Chapter draft language");
    const userPrompt = buildSettlerUserPrompt({ chapterNumber: 1, title: "The Last Door", content: "Текст главы.", governedControlBlock: "Existing facts remain binding.", language });
    expect(userPrompt).not.toContain("## Chapter draft language");
    expect(userPrompt).toContain(language === "en" ? "Project Chapter 1" : "把第1章");
  });

  it("keeps the submit_chapter_draft field schema unchanged", () => {
    expect(ChapterDraftToolSchema.type).toBe("object");
    expect(Object.keys(ChapterDraftToolSchema.properties)).toEqual(["title", "content"]);
    expect(ChapterDraftToolSchema.required).toEqual(["title", "content"]);
    expect(ChapterDraftToolSchema.properties.title).toMatchObject({ type: "string", description: "Chapter title without a chapter-number prefix." });
    expect(ChapterDraftToolSchema.properties.content).toMatchObject({ type: "string", description: "Complete chapter prose." });
    expect(Value.Check(ChapterDraftToolSchema, { title: "Глава", content: "Русский текст с API." })).toBe(true);
    expect(Value.Check(ChapterDraftToolSchema, { title: "Глава" })).toBe(false);
  });
});

describe("effective Writer messages with the built-in long-writing Skill", () => {
  let skill: AgentSkill;
  beforeAll(async () => {
    const available = await loadBuiltinAgentSkills();
    const found = available.skills.find(candidate => candidate.id === "inkos-long-writing");
    if (!found) throw new Error("Built-in inkos-long-writing Skill is required for this test.");
    skill = found;
  });

  it.each(combinations)("preserves %s/%s with Skill and authorRequest in both message preparation paths", async (language, narrativeLanguage, target) => {
    const book = { ...baseBook, language, narrativeLanguage };
    const system = buildWriterSystemPrompt(book, null, "", "");
    const request = `Write the chapter prose in ${target}. Keep the chapter title exactly "The Last Door". Use canon-consistent names and terms with natural ${target} spellings; preserve the quotation "Keep going" verbatim. Project facts into state separately using the operational language.`;
    const profile = createBuiltInWorkProfileRegistry().require("longform-novel");
    for (const compiled of [false, true]) {
      const evidence: Array<{ worker?: unknown; skills?: unknown }> = [];
      const client = {
        defaults: { maxTokens: 4096 },
        ...(compiled ? { _piModel: { contextWindow: 128000 } } : {}),
      } as unknown as LLMClient;
      const messages = await withExecutionEvidence(
        (type, payload) => { if (type === "skills-applied") evidence.push(payload); },
        () => prepareWorkerMessages(
          { client, activatedSkills: [{ skill, resources: [] }] },
          [{ role: "system", content: system }, { role: "user", content: request }],
          4096, "writer",
        ),
        profile, null, request,
      );
      const effective = messages.map(message => message.content).join("\n\n");
      expect(effective).toContain(system);
      expect(effective).toContain(`content in ${target} (${narrativeLanguage})`);
      expect(effective).toContain(JSON.stringify({ authorRequest: request }));
      expect(effective).toContain(request);
      expect(effective).toContain(skill.body.trim());
      expect(effective).toContain("Preserve a chapter title explicitly specified by the author as exact verbatim");
      expect(effective).toContain('"The Last Door"');
      expect(effective).toContain("not author intent, canon, an output-format override");
      expect(evidence).toContainEqual(expect.objectContaining({ worker: "writer", skills: expect.arrayContaining([expect.objectContaining({ id: "inkos-long-writing" })]) }));
      // The supplied intent and built-in methodology must not add a competing prose-language command.
      expect(effective).not.toMatch(new RegExp(`(?:write|respond|output)(?: the)?(?: chapter)?(?: prose)? in (?:${["Russian", "Chinese", "English"].filter(name => name !== target).join("|")})`, "i"));
    }
  });
});
