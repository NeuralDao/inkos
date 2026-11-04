import { describe, expect, it } from "vitest";
import { stripReasoningDisable } from "../agent/pi-stream.js";
import { REASONING_LEVELS, isReasoningLevel, reasoningActivation, reasoningLevelOf } from "../llm/reasoning.js";
import { AgentLLMOverrideSchema, LLMConfigSchema, ReasoningPreferenceSchema } from "../models/project.js";

/**
 * Regression suite for the reasoning policy.
 *
 * The historical `applyDefaultReasoningPolicy` rewrote an explicit disable into
 * `low` for reasoning-capable models, which made zero reasoning unreachable, and
 * it handled three of the four wire shapes. The fourth (`reasoning.enabled`)
 * produced 47 live `400 Reasoning is mandatory ... cannot be disabled` failures.
 */
describe("reasoning disable is never sent on the wire", () => {
  it.each([
    ["reasoning_effort", { reasoning_effort: "none" }],
    ["reasoning.effort", { reasoning: { effort: "none" } }],
    ["reasoning.enabled", { reasoning: { enabled: false } }],
    ["thinking.type", { thinking: { type: "disabled" } }],
    ["enable_thinking", { enable_thinking: false }],
  ])("removes %s", (_label, payload) => {
    const result = stripReasoningDisable(payload) as Record<string, unknown>;
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result).not.toHaveProperty("reasoning");
    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("enable_thinking");
  });

  it("never substitutes a level for a disable", () => {
    const result = stripReasoningDisable({ reasoning: { enabled: false }, reasoning_effort: "none" }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain("low");
    expect(result).toEqual({});
  });

  it("keeps an explicit effort level untouched", () => {
    expect(stripReasoningDisable({ reasoning: { effort: "high" } })).toEqual({ reasoning: { effort: "high" } });
    expect(stripReasoningDisable({ reasoning_effort: "minimal" })).toEqual({ reasoning_effort: "minimal" });
  });

  it("keeps an enabled thinking budget untouched", () => {
    const payload = { thinking: { type: "enabled", budget_tokens: 2048 }, max_tokens: 4096 };
    expect(stripReasoningDisable(payload)).toEqual(payload);
  });

  it("leaves unrelated payload fields intact and tolerates non-objects", () => {
    expect(stripReasoningDisable({ model: "x", messages: [], tool_choice: "required", reasoning: { enabled: false } }))
      .toEqual({ model: "x", messages: [], tool_choice: "required" });
    expect(stripReasoningDisable(undefined)).toBeUndefined();
    expect(stripReasoningDisable("text")).toBe("text");
    expect(stripReasoningDisable([{ reasoning: { enabled: false } }])).toEqual([{ reasoning: { enabled: false } }]);
  });
});

describe("reasoning preference contract", () => {
  it("accepts boolean and the four levels, rejects everything else", () => {
    for (const value of [true, false, ...REASONING_LEVELS]) expect(ReasoningPreferenceSchema.safeParse(value).success).toBe(true);
    for (const value of ["none", "disabled", "xhigh", 0, "HIGH"]) expect(ReasoningPreferenceSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a level in a per-agent override and in the project config", () => {
    expect(AgentLLMOverrideSchema.safeParse({ model: "m", reasoning: "low" }).success).toBe(true);
    const config = LLMConfigSchema.parse({
      provider: "openai", baseUrl: "https://example.com/v1", apiKey: "k", model: "m", reasoning: "medium",
    });
    expect(config.reasoning).toBe("medium");
  });

  it("derives activation and level separately", () => {
    expect(reasoningActivation("low", 0)).toBe(true);
    expect(reasoningActivation(undefined, 4096)).toBe(true);
    expect(reasoningActivation(undefined, 0)).toBe(false);
    expect(reasoningActivation(false, 4096)).toBe(false);
    expect(reasoningLevelOf("medium")).toBe("medium");
    expect(reasoningLevelOf(true)).toBeUndefined();
    expect(reasoningLevelOf(false)).toBeUndefined();
    expect(isReasoningLevel("high")).toBe(true);
    expect(isReasoningLevel("xhigh")).toBe(false);
  });
});
