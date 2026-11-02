import { describe, expect, it } from "vitest";
import { resolveObservationSources } from "../models/observation.js";

describe("resolveObservationSources", () => {
  const sourceId = "chapter-5";
  const source = "first line\nsecond line\nfinal line";
  const sources = new Map([[sourceId, source]]);
  const observation = (startLine: number, endLine: number) => ({
    code: "TEST_FINDING",
    summary: "A source-backed observation",
    evidence: [],
    sourceRefs: [{ sourceId, startLine, endLine }],
  });

  it.each([4, 5])("clamps endLine=%i to the exact final source line", (endLine) => {
    const [resolved] = resolveObservationSources([observation(3, endLine)], sources);
    expect(resolved?.sourceRefs).toEqual([{ sourceId, quote: "final line" }]);
  });

  it("rejects citation ranges more than two lines past EOF", () => {
    let failure: unknown;
    try { resolveObservationSources([observation(3, 6)], sources); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "REVIEW_SOURCE_RANGE_INVALID", lineCount: 3, endLine: 6 });
  });

  it("does not repair an invalid start line", () => {
    let failure: unknown;
    try { resolveObservationSources([observation(4, 4)], sources); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "REVIEW_SOURCE_RANGE_INVALID", lineCount: 3 });
  });
});
