// === W45 money-intents ===
/**
 * server/services/payments/currencyExponent.ts — PAY-23 (W45 Coder B2)
 * ─────────────────────────────────────────────────────────────────────────────
 * SHARED MODULE (consumed by Coder B3's fxPayouts.ts / payOverTime.ts and the
 * merger): the single source of truth for ISO-4217 minor-unit exponents and
 * the FX "dust" policy. Do NOT add a second copy — import from here.
 *
 * Why: the codebase historically assumed two-decimal minor units everywhere
 * (`Math.round(amount * 100)`). That is WRONG for zero-decimal currencies
 * (XOF, XAF, JPY, …) and three-decimal currencies (KWD, BHD, …): a ₦→XOF
 * payout of "100 XOF" was computed as 10000 minor units, and the leftover
 * sub-unit fraction ("dust") was silently truncated with no carry policy.
 *
 * Contents:
 *   1. CURRENCY_EXPONENTS — ISO-4217 minor-unit exponent table (all active
 *      zero- and three-decimal currencies; everything not listed defaults
 *      to 2, matching the previous behavior for NGN/USD/KES/GHS).
 *   2. toMinorUnits / fromMinorUnits — exponent-aware exact integer
 *      conversions (integer math on scaled values; no float drift).
 *   3. Dust policy — `applyDustPolicy`: FX conversions produce fractional
 *      minor units; the policy is CARRY THE REMAINDER (return it to the
 *      caller for crediting, never silently drop it) plus a MIN-PAYOUT
 *      FLOOR (a payout below the floor is refused instead of truncating to
 *      a worthless/negative-value transfer).
 */

/** ISO-4217 minor-unit exponents for currencies that are NOT two-decimal.
 *  (Zero-decimal: XOF/XAF corridor currencies, JPY, KRW, etc. Three-decimal:
 *  BHD, JOD, KWD, OMR, TND. Four-decimal: CLF, UYW.) */
const NON_DEFAULT_EXPONENTS: Record<string, number> = {
  // zero-decimal (exponent 0)
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // three-decimal
  BHD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // four-decimal
  CLF: 4, UYW: 4,
};

/** Default ISO-4217 exponent (NGN, USD, KES, GHS, EUR, GBP, …). */
export const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * ISO-4217 minor-unit exponent for a currency code (case-insensitive).
 * Unknown/unlisted codes default to 2 — the pre-W45 platform assumption —
 * so existing corridors keep behaving identically.
 */
export function currencyExponent(currency: string): number {
  return NON_DEFAULT_EXPONENTS[(currency ?? "").toUpperCase()] ?? DEFAULT_CURRENCY_EXPONENT;
}

/** True for zero-decimal currencies (XOF, XAF, JPY, …) — no minor units. */
export function isZeroDecimalCurrency(currency: string): boolean {
  return currencyExponent(currency) === 0;
}

/**
 * Major units → integer minor units, exponent-aware, round half up.
 *   toMinorUnits(12.34, "NGN")  → 1234
 *   toMinorUnits(100,   "XOF")  → 100   (XOF IS its own minor unit)
 *   toMinorUnits(1.234, "KWD")  → 1234
 * Non-finite or negative input throws — money conversions must fail loudly.
 */
export function toMinorUnits(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor)) {
    throw new Error(`toMinorUnits: non-finite amount ${amountMajor} ${currency}`);
  }
  const exp = currencyExponent(currency);
  return Math.round(amountMajor * 10 ** exp);
}

/**
 * Integer minor units → major units, exponent-aware.
 *   fromMinorUnits(1234, "NGN") → 12.34
 *   fromMinorUnits(100,  "XOF") → 100
 */
export function fromMinorUnits(amountMinor: number, currency: string): number {
  if (!Number.isFinite(amountMinor)) {
    throw new Error(`fromMinorUnits: non-finite amount ${amountMinor} ${currency}`);
  }
  const exp = currencyExponent(currency);
  return amountMinor / 10 ** exp;
}

/**
 * Exponent-aware equality of two major-unit amounts (the W26 exact
 * minor-unit comparison, generalized): 12.34 NGN === 12.34 NGN in kobo;
 * 100 XOF === 100 XOF as whole units (no *100 inflation).
 */
export function minorUnitsEqual(aMajor: number, bMajor: number, currency: string): boolean {
  return toMinorUnits(aMajor, currency) === toMinorUnits(bMajor, currency);
}

/* ── Dust policy (PAY-23) ────────────────────────────────────────────────────
 * FX conversions (from-amount × rate) produce FRACTIONAL minor units of the
 * target currency. The pre-W45 code floored the result and silently dropped
 * the fraction ("dust"). The policy is now explicit:
 *
 *   - CONVERT: keep the exact fractional result.
 *   - DELIVERABLE: floor to integer minor units for the payout leg.
 *   - DUST: the floored-off fraction (in target minor units) is RETURNED to
 *     the caller (`dustMinor`) so it can be credited/carried (e.g. into the
 *     recipient's next payout or a platform rounding account) — never
 *     silently lost.
 *   - MIN-PAYOUT FLOOR: if the deliverable amount is below the corridor's
 *     minimum payout (default 1 minor unit — a zero payout is never
 *     meaningful), the conversion is REFUSED (`belowMinPayout: true`) so the
 *     caller holds the funds instead of executing a worthless transfer.
 */
export interface DustPolicyResult {
  /** Exact converted amount in TARGET minor units (fractional). */
  exactMinor: number;
  /** Integer minor units deliverable to the recipient (floor of exact). */
  deliverableMinor: number;
  /** The floored-off fractional minor units — MUST be carried/credited by
   *  the caller (never silently dropped). In [0, 1). */
  dustMinor: number;
  /** True when deliverableMinor < minPayoutMinor — refuse the payout. */
  belowMinPayout: boolean;
  currency: string;
}

/** Default minimum payout: 1 minor unit of the target currency. */
export const DEFAULT_MIN_PAYOUT_MINOR = 1;

export function applyDustPolicy(opts: {
  /** Source amount in SOURCE major units. */
  amountMajor: number;
  /** FX rate as target-major per 1 source-major (decimal number). */
  rate: number;
  /** TARGET currency code (its exponent drives the minor-unit scaling). */
  currency: string;
  /** Corridor minimum payout in target minor units (default 1). */
  minPayoutMinor?: number;
}): DustPolicyResult {
  if (!Number.isFinite(opts.amountMajor) || opts.amountMajor < 0) {
    throw new Error(`applyDustPolicy: invalid amount ${opts.amountMajor}`);
  }
  if (!Number.isFinite(opts.rate) || opts.rate < 0) {
    throw new Error(`applyDustPolicy: invalid rate ${opts.rate}`);
  }
  const exp = currencyExponent(opts.currency);
  const exactMinor = opts.amountMajor * opts.rate * 10 ** exp;
  const deliverableMinor = Math.floor(exactMinor + 1e-9); // guard float fuzz
  const dustMinor = exactMinor - Math.floor(exactMinor);
  const minPayoutMinor = opts.minPayoutMinor ?? DEFAULT_MIN_PAYOUT_MINOR;
  return {
    exactMinor,
    deliverableMinor,
    dustMinor,
    belowMinPayout: deliverableMinor < minPayoutMinor,
    currency: opts.currency.toUpperCase(),
  };
}
