/**
 * shared/escrowAmounts.ts — Integer minor-units escrow fee split.
 *
 * The previous float split (`fee = gross * rate; net = gross - fee`, then
 * toFixed(2)) violated the conservation invariant fee + net == gross for ~2%
 * of amounts: two independent roundings of fee and net can each drift a kobo
 * in opposite directions (rate is numeric(6,4), e.g. 0.03125).
 *
 * This module does ALL math in integer minor units (kobo):
 *   feeMinor = round(grossMinor × rate)   — round half up, exactly once
 *   netMinor = grossMinor − feeMinor      — derived, never independently rounded
 * so feeMinor + netMinor == grossMinor holds for EVERY amount and rate.
 */

export interface EscrowAmountSplit {
  /** Gross amount in integer minor units (kobo). */
  grossMinor: number;
  /** Platform fee in integer minor units. */
  feeMinor: number;
  /** Merchant net in integer minor units (grossMinor - feeMinor). */
  netMinor: number;
  /** Gross as a major-units decimal string ("123.45"). */
  gross: string;
  /** Platform fee as a major-units decimal string. */
  fee: string;
  /** Merchant net as a major-units decimal string. */
  net: string;
  /** The effective rate used. */
  rate: number;
}

/** Convert a major-units amount (number or decimal string) to integer minor units. */
export function toMinorUnitsExact(amount: number | string): number {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`invalid amount: ${amount}`);
    }
    // Round half up to absorb binary float representation error (e.g. 19.99).
    return Math.round(amount * 100);
  }
  const s = amount.trim();
  if (!/^\d+(\.\d{1,})?$/.test(s)) {
    throw new Error(`invalid amount: ${amount}`);
  }
  const [whole, frac = ""] = s.split(".");
  // Round half up at the 3rd decimal (kobo granularity).
  const fracPadded = (frac + "000").slice(0, 3);
  let minor = parseInt(whole, 10) * 100 + parseInt(fracPadded.slice(0, 2), 10);
  if (parseInt(fracPadded[2], 10) >= 5) minor += 1;
  return minor;
}

/** Format integer minor units as a major-units decimal string with 2 decimals. */
export function minorUnitsToString(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new Error(`invalid minor-units amount: ${minor}`);
  }
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/**
 * Split a gross amount into platform fee + merchant net using integer minor
 * units. Guarantees feeMinor + netMinor === grossMinor for all inputs.
 *
 * @param grossAmount amount in MAJOR units (number or decimal string)
 * @param rate        fee rate as a fraction (e.g. 0.03125 for 3.125%);
 *                    accepts the numeric(6,4) string straight from escrow_config
 */
export function splitEscrowAmounts(grossAmount: number | string, rate: number | string): EscrowAmountSplit {
  const r = typeof rate === "string" ? parseFloat(rate) : rate;
  if (!Number.isFinite(r) || r < 0 || r >= 1) {
    throw new Error(`invalid fee rate: ${rate}`);
  }
  const grossMinor = toMinorUnitsExact(grossAmount);
  // Single rounding point, round half up.
  const feeMinor = Math.round(grossMinor * r);
  const netMinor = grossMinor - feeMinor;
  return {
    grossMinor,
    feeMinor,
    netMinor,
    gross: minorUnitsToString(grossMinor),
    fee: minorUnitsToString(feeMinor),
    net: minorUnitsToString(netMinor),
    rate: r,
  };
}
