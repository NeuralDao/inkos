import { describe, expect, it } from "vitest";
import {
  classifyResultFailure,
  createRepairBudget,
  DEFAULT_REPAIR_POLICY,
  repairDiagnostic,
  repairSignature,
} from "../agent/result-repair.js";

describe("result repair classification", () => {
  it("treats citation and schema rejections as correctable", () => {
    for (const code of ["REVIEW_SOURCE_REQUIRED", "REVIEW_SOURCE_RANGE_INVALID", "REVIEW_SCOPE_EVIDENCE_REQUIRED", "WORKER_SCHEMA_INVALID", "WORKER_DOMAIN_INVALID"]) {
      expect(classifyResultFailure(code)).toBe("correctable");
    }
  });

  it("does not repair transport failures", () => {
    for (const code of ["MODEL_EMPTY_RESPONSE", "MODEL_OUTPUT_LIMIT", "WORKER_MODEL_ERROR", "WORKER_RESPONSE_ARCHIVE_FAILED"]) {
      expect(classifyResultFailure(code)).toBe("transient");
    }
  });

  it("refuses to guess for an unregistered code", () => {
    expect(classifyResultFailure("SOMETHING_NEW")).toBe("fatal");
    expect(classifyResultFailure(undefined)).toBe("correctable");
  });

  it("produces a stable signature that includes the failure location", () => {
    const a = repairSignature("REVIEW_SOURCE_REQUIRED", "line 150 is blank");
    expect(a).toBe(repairSignature("REVIEW_SOURCE_REQUIRED", "line 150 is blank"));
    expect(a).not.toBe(repairSignature("REVIEW_SOURCE_REQUIRED", "line 151 is blank"));
    expect(a).not.toBe(repairSignature("REVIEW_SOURCE_RANGE_INVALID", "line 150 is blank"));
  });
});

describe("repair budget", () => {
  it("grants the single correction turn allowed by the default policy", () => {
    const budget = createRepairBudget(DEFAULT_REPAIR_POLICY);
    const first = budget.grant("REVIEW_SOURCE_REQUIRED", "line 150 is blank");
    expect(first).toMatchObject({ granted: true, reason: "granted", repairClass: "correctable", used: 1, limit: 1 });
    expect(budget.used).toBe(1);

    const second = budget.grant("REVIEW_SOURCE_RANGE_INVALID", "range 918-949 beyond 948");
    expect(second).toMatchObject({ granted: false, reason: "budget-exhausted" });
    expect(budget.used).toBe(1);
  });

  it("stops repairing when the model repeats the same failure", () => {
    const budget = createRepairBudget({ maxRepairs: 3, maxRepairsPerSignature: 1 });
    expect(budget.grant("REVIEW_SOURCE_REQUIRED", "line 150 is blank").granted).toBe(true);
    const repeat = budget.grant("REVIEW_SOURCE_REQUIRED", "line 150 is blank");
    expect(repeat).toMatchObject({ granted: false, reason: "repeated" });
  });

  it("never repairs an unrepairable class", () => {
    const budget = createRepairBudget({ maxRepairs: 5 });
    expect(budget.grant("WORKER_MODEL_ERROR", "provider returned 502")).toMatchObject({ granted: false, reason: "unrepairable", repairClass: "transient" });
    expect(budget.grant("SOMETHING_NEW", "unknown").reason).toBe("unrepairable");
    expect(budget.used).toBe(0);
  });

  it("bounds the diagnostic handed back to the model", () => {
    const diagnostic = repairDiagnostic("REVIEW_SOURCE_REQUIRED", "x".repeat(2000), 120);
    expect(diagnostic.startsWith("REVIEW_SOURCE_REQUIRED: ")).toBe(true);
    expect(diagnostic.length).toBeLessThan(200);
  });
});
