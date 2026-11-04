import type { FindingDisposition } from "../agents/reviser.js";
import type { RevisionFinding } from "./auto-revision-policy.js";

/**
 * A disposition is the reviser's claim about its own work. "addressed" is only
 * credible when the passage the finding cited actually changed — otherwise the
 * claim is false and the canon would record a defect as fixed.
 *
 * Verification is text-based on purpose: it does not consult the model.
 */

export interface VerificationOutcome {
  readonly dispositions: FindingDisposition[];
  /** Findings the reviser claimed but whose cited passage is unchanged. */
  readonly downgraded: Array<{ findingId: string; quote: string }>;
  /** Findings whose claim could not be checked (no source citation). */
  readonly unverifiable: string[];
}

const MINIMUM_QUOTE_LENGTH = 3;

/** Whitespace-insensitive form: the model may rewrap the same words. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/gu, "").toLocaleLowerCase();
}

function quotedEvidence(finding: RevisionFinding): string[] {
  const refs = finding.observation.sourceRefs ?? [];
  return refs
    .map((reference) => reference.quote.trim())
    .filter((quote) => quote.length >= MINIMUM_QUOTE_LENGTH);
}

/**
 * Downgrade an unbacked "addressed" claim to "not_addressed" and keep the
 * reviser's own explanation, so the record shows both claim and evidence.
 */
export function verifyFindingDispositions(
  dispositions: ReadonlyArray<FindingDisposition>,
  findings: ReadonlyArray<RevisionFinding>,
  revisedContent: string,
): VerificationOutcome {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const haystack = normalizeQuote(revisedContent);
  const downgraded: Array<{ findingId: string; quote: string }> = [];
  const unverifiable: string[] = [];

  const verified = dispositions.map((disposition) => {
    if (disposition.status !== "addressed") return disposition;
    const finding = byId.get(disposition.findingId);
    const quotes = finding ? quotedEvidence(finding) : [];
    if (quotes.length === 0) {
      unverifiable.push(disposition.findingId);
      return disposition;
    }
    const unchanged = quotes.find((quote) => haystack.includes(normalizeQuote(quote)));
    if (unchanged === undefined) return disposition;

    downgraded.push({ findingId: disposition.findingId, quote: unchanged.slice(0, 200) });
    return {
      ...disposition,
      status: "not_addressed" as const,
      explanation: `${disposition.explanation} [host verification: the cited passage is still present in the revised chapter, so this claim of completion was downgraded]`,
    };
  });

  return { dispositions: verified, downgraded, unverifiable };
}
