/** Application-level ceilings. Provider model cards remain authoritative for actual capabilities. */
export const MAX_MODEL_INPUT_TOKENS = 96_000;
export const MAX_MODEL_OUTPUT_TOKENS = 96_000;
export const FALLBACK_MODEL_CONTEXT_TOKENS = MAX_MODEL_INPUT_TOKENS + MAX_MODEL_OUTPUT_TOKENS + 8_000;
