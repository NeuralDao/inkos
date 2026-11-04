/**
 * Explicit reasoning preference for one model call.
 *
 * `boolean` is kept for backwards compatibility and means only "activate the
 * provider's reasoning mode" / "do not request it". The string form is the
 * actual effort level and is forwarded to the transport verbatim.
 *
 * Semantics that callers must rely on:
 * - `undefined` — the host does not request reasoning and sends no directive;
 * - `false`      — the host still sends no directive (never an explicit disable,
 *                  which some endpoints reject with HTTP 400);
 * - `"low"` etc. — the level is sent as the provider's reasoning effort.
 *
 * There is deliberately no way to *forbid* reasoning: several endpoints make it
 * mandatory, and asking for a disable is what produced
 * `400 Reasoning is mandatory for this endpoint and cannot be disabled`.
 */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ReasoningPreference = boolean | ReasoningLevel;

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as ReadonlyArray<string>).includes(value);
}

/** pi-ai needs a boolean activation flag; the level itself travels per call. */
export function reasoningActivation(preference: ReasoningPreference | undefined, thinkingBudget: number): boolean {
  if (typeof preference === "string") return true;
  return preference ?? thinkingBudget > 0;
}

/** The effort level to forward per call, if the author asked for one. */
export function reasoningLevelOf(preference: ReasoningPreference | undefined): ReasoningLevel | undefined {
  return isReasoningLevel(preference) ? preference : undefined;
}

const REASONING_MARKERS = /(reasoning|thinking|thinking_budget|reasoning_effort|enable_thinking)/i;

/**
 * True when a provider rejected the request specifically because of a
 * reasoning/thinking directive (HTTP 400). The status can arrive either as a
 * structured field or only inside the message text, depending on the transport,
 * so both shapes are accepted. A bare 400 without a reasoning marker is not a
 * reasoning rejection and must keep propagating.
 */
export function isReasoningRejection(value: unknown): boolean {
  const texts: string[] = [];
  const collect = (input: unknown, depth = 0): void => {
    if (!input || depth > 3) return;
    if (typeof input === "string") { texts.push(input); return; }
    if (typeof input !== "object") return;
    const record = input as Record<string, unknown>;
    for (const key of ["errorMessage", "message", "error", "reason", "body", "cause", "detail"]) {
      const nested = record[key];
      if (typeof nested === "string") texts.push(nested);
      else if (nested && typeof nested === "object") collect(nested, depth + 1);
    }
  };
  collect(value);
  const joined = texts.join("\n");
  const numericStatus = (() => {
    let found = false;
    const walk = (input: unknown, depth = 0): void => {
      if (found || !input || typeof input !== "object" || depth > 3) return;
      const record = input as Record<string, unknown>;
      for (const key of ["status", "statusCode", "code", "httpStatus"]) {
        if (record[key] === 400 || record[key] === "400") { found = true; return; }
      }
      for (const key of ["error", "body", "cause", "response"]) walk(record[key], depth + 1);
    };
    walk(value);
    return found;
  })();
  if (!joined && !numericStatus) return false;
  const mentions400 = numericStatus || /\b400\b/.test(joined);
  return mentions400 && REASONING_MARKERS.test(joined);
}
