import { describe, expect, it } from "vitest";
import { verifyFindingDispositions } from "../pipeline/finding-verification.js";
import type { RevisionFinding } from "../pipeline/auto-revision-policy.js";

const finding = (id: string, quote?: string): RevisionFinding => ({
  id,
  observation: {
    code: "QUALITY",
    summary: `finding ${id}`,
    evidence: [],
    assessment: "issue",
    ...(quote === undefined ? {} : { sourceRefs: [{ sourceId: "governed-context", quote }] }),
  },
});

const disposition = (findingId: string, status: "addressed" | "not_addressed" | "rejected", explanation = "done") =>
  ({ findingId, status, explanation });

describe("finding disposition verification", () => {
  it("downgrades a claim whose cited passage is untouched", () => {
    const findings = [finding("finding-5", "утреник")];
    const outcome = verifyFindingDispositions(
      [disposition("finding-5", "addressed")],
      findings,
      "Утреник ударил в колокол, а правка была совсем в другой сцене.",
    );

    expect(outcome.dispositions[0]).toMatchObject({ findingId: "finding-5", status: "not_addressed" });
    expect(outcome.dispositions[0]!.explanation).toContain("host verification");
    expect(outcome.downgraded).toEqual([{ findingId: "finding-5", quote: "утреник" }]);
  });

  it("keeps a claim whose cited passage was rewritten", () => {
    const findings = [finding("finding-1", "Он вошёл в цех и остановился.")];
    const outcome = verifyFindingDispositions(
      [disposition("finding-1", "addressed")],
      findings,
      "Он шагнул в цех, замер у верстака и прислушался.",
    );

    expect(outcome.dispositions[0]!.status).toBe("addressed");
    expect(outcome.downgraded).toEqual([]);
  });

  it("sees through rewrapping and case, which are not edits", () => {
    const findings = [finding("finding-2", "первый луч над стапелем\nи тишина")];
    const outcome = verifyFindingDispositions(
      [disposition("finding-2", "addressed")],
      findings,
      "Первый луч над стапелем и тишина.",
    );

    expect(outcome.dispositions[0]!.status).toBe("not_addressed");
    expect(outcome.downgraded).toHaveLength(1);
  });

  it("reports a claim it cannot check instead of inventing a verdict", () => {
    const findings = [finding("finding-3")];
    const outcome = verifyFindingDispositions([disposition("finding-3", "addressed")], findings, "любой текст");

    expect(outcome.dispositions[0]!.status).toBe("addressed");
    expect(outcome.unverifiable).toEqual(["finding-3"]);
  });

  it("never rewrites a disposition the reviser did not claim", () => {
    const findings = [finding("finding-4", "стапель")];
    const outcome = verifyFindingDispositions(
      [disposition("finding-4", "not_addressed", "вне диапазона правки"), disposition("finding-6", "rejected", "не по делу")],
      [finding("finding-4", "стапель"), finding("finding-6")],
      "стапель остался как был",
    );

    expect(outcome.dispositions.map(item => item.status)).toEqual(["not_addressed", "rejected"]);
    expect(outcome.downgraded).toEqual([]);
  });
});
