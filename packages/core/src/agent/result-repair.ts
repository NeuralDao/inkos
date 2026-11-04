/**
 * Technical self-repair for structured worker results.
 *
 * A rejected tool call is not always a defect of the pipeline: most domain
 * validation failures (a blank citation, an out-of-range line span, a schema
 * mismatch) are correctable by the model itself if the rejection is handed
 * back with a diagnostic. Others are not (transport failures, empty output),
 * and some must never be retried silently (unknown codes: an unseen failure
 * has to be looked at, not papered over).
 *
 * This module is the single place that decides which failures deserve another
 * turn. Agents must not grow their own per-error retry logic.
 */

export type RepairClass = "correctable" | "transient" | "fatal";

export type RepairReason = "granted" | "budget-exhausted" | "repeated" | "unrepairable";

export interface RepairPolicy {
  /** Correction turns granted for one worker stage in total. */
  readonly maxRepairs: number;
  /** How many times one failure signature may be repaired. Defaults to 1. */
  readonly maxRepairsPerSignature?: number;
}

/** One correction turn, and never the same failure twice. */
export const DEFAULT_REPAIR_POLICY: RepairPolicy = { maxRepairs: 1, maxRepairsPerSignature: 1 };

export interface RepairGrant {
  readonly granted: boolean;
  readonly reason: RepairReason;
  readonly repairClass: RepairClass;
  /** Correction turns already consumed on this stage. */
  readonly used: number;
  /** Total correction turns allowed by the policy. */
  readonly limit: number;
}

/** Failures whose diagnostic points at something the model can actually fix. */
const CORRECTABLE_CODES = /^(?:WORKER_SCHEMA_INVALID|WORKER_DOMAIN_INVALID|REVIEW_[A-Z0-9_]+)$/;

/** Failures of the transport, not of the model's answer: repair cannot help. */
const TRANSIENT_CODES = /^(?:MODEL_EMPTY_RESPONSE|MODEL_OUTPUT_LIMIT|WORKER_MODEL_ERROR|WORKER_RESPONSE_ARCHIVE_FAILED|CHAPTER_REPLAY_FAILURE)$/;

export function classifyResultFailure(code: string | undefined): RepairClass {
  const normalized = (code ?? "").trim();
  if (normalized.length === 0) return "correctable";
  if (CORRECTABLE_CODES.test(normalized)) return "correctable";
  if (TRANSIENT_CODES.test(normalized)) return "transient";
  // An unregistered code is a gap in this file, not a task for the model.
  return "fatal";
}

/** Stable identity of a failure: same code in the same place means "no progress". */
export function repairSignature(code: string | undefined, message: string): string {
  const source = `${(code ?? "").trim()}|${message.slice(0, 400)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface RepairBudget {
  readonly used: number;
  grant(code: string | undefined, message: string): RepairGrant;
}

export function createRepairBudget(policy: RepairPolicy = DEFAULT_REPAIR_POLICY): RepairBudget {
  const limit = Math.max(0, Math.floor(policy.maxRepairs));
  const perSignature = Math.max(1, Math.floor(policy.maxRepairsPerSignature ?? 1));
  const seen = new Map<string, number>();
  let used = 0;

  return {
    get used() {
      return used;
    },
    grant(code, message) {
      const repairClass = classifyResultFailure(code);
      const signature = repairSignature(code, message);
      const repeats = seen.get(signature) ?? 0;
      const verdict = (granted: boolean, reason: RepairReason): RepairGrant =>
        ({ granted, reason, repairClass, used, limit });

      if (repairClass !== "correctable") return verdict(false, "unrepairable");
      if (used >= limit) return verdict(false, "budget-exhausted");
      if (repeats >= perSignature) return verdict(false, "repeated");

      seen.set(signature, repeats + 1);
      used += 1;
      return verdict(true, "granted");
    },
  };
}

/** Diagnostic handed back to the model: what failed and where, bounded in size. */
export function repairDiagnostic(code: string | undefined, message: string, limit = 800): string {
  const trimmed = message.trim();
  const body = trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
  return `${code ?? "WORKER_DOMAIN_INVALID"}: ${body}`;
}
