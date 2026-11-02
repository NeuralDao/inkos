import { describe, expect, it } from "vitest";
import { actionableFindings, revisionModeFor } from "../pipeline/auto-revision-policy.js";

describe("automatic revision policy", () => {
  const issue = { code: "continuity", summary: "A contradiction", evidence: ["source"], assessment: "issue" as const, scope: "local" };

  it("selects only actionable findings and preserves their original positions", () => {
    const findings = actionableFindings([
      { code: "unavailable", summary: "Review unavailable", evidence: [], assessment: "unavailable" },
      issue,
      { ...issue, code: "provider", category: "execution" },
    ]);
    expect(findings).toEqual([{ id: "finding-2", observation: issue }]);
    expect(revisionModeFor(findings)).toBe("spot-fix");
    expect(revisionModeFor([{ id: "finding-1", observation: { ...issue, scope: "structural" } }])).toBe("rework");
  });
});
