/**
 * Risk-based terms (W18) — deterministic score → facility terms band map.
 *
 * The deterministic credit score (scoring.suggestLimitTx) maps to the terms
 * a supplier is advised to extend: tenor (net-days) and a facility fee in
 * basis points. Higher trust ⇒ longer tenor, lower fee; below the minimum
 * score the suggestion is to DECLINE credit entirely.
 *
 * Bands (checked top-down, first match wins):
 *   score ≥ 80  → 45d tenor, 0% fee
 *   60–79       → 30d tenor, 1.5% fee (150 bps)
 *   40–59       → 21d tenor, 2.5% fee (250 bps)
 *   20–39       → 14d tenor, 3.5% fee (350 bps)
 *   < 20        → decline (no credit suggested)
 *
 * Pure function of the score: deterministic, no I/O, no randomness.
 */
export interface TermsBand {
  /** Inclusive lower score bound for this band. */
  minScore: number;
  tenorDays: number;
  feeBps: number;
  decline: boolean;
}

export const TERMS_BANDS: readonly TermsBand[] = [
  { minScore: 80, tenorDays: 45, feeBps: 0, decline: false },
  { minScore: 60, tenorDays: 30, feeBps: 150, decline: false },
  { minScore: 40, tenorDays: 21, feeBps: 250, decline: false },
  { minScore: 20, tenorDays: 14, feeBps: 350, decline: false },
  { minScore: 0, tenorDays: 0, feeBps: 0, decline: true },
] as const;

export interface CreditTerms {
  tenorDays: number;
  feeBps: number;
  /** true ⇒ score is below the minimum band — suggest declining credit. */
  decline: boolean;
}

/** Map a 0..100 credit score onto its terms band (clamped input). */
export function termsForScore(score: number): CreditTerms {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  for (const band of TERMS_BANDS) {
    if (s >= band.minScore) {
      return { tenorDays: band.tenorDays, feeBps: band.feeBps, decline: band.decline };
    }
  }
  // Unreachable: the last band has minScore 0.
  return { tenorDays: 0, feeBps: 0, decline: true };
}
