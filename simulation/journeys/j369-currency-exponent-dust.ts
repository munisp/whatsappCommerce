// === W45 money-intents (Coder B2) ===
/**
 * J369 — PAY-23: ISO-4217 currency exponents + dust policy.
 *
 * Asserts the shared currencyExponent module (XOF zero-decimal, KWD
 * three-decimal, NGN default) and that the Paystack TRANSFER path sends
 * exponent-aware minor units (a 100 XOF payout sends amount=100, NOT 10000),
 * plus the dust policy: fractional remainders are carried (returned), never
 * silently truncated, and below-floor payouts are refused.
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J369",
  name: "PAY-23: ISO-4217 exponents (XOF zero-decimal) + dust policy",
  feature: "W45 services/payments/currencyExponent.ts",
  async run(world: World) {
    const {
      currencyExponent, isZeroDecimalCurrency, toMinorUnits, fromMinorUnits,
      minorUnitsEqual, applyDustPolicy,
    } = await import("../../server/services/payments/currencyExponent");

    // ── Exponent table ────────────────────────────────────────────────────
    assert(currencyExponent("NGN") === 2, "NGN two-decimal");
    assert(currencyExponent("USD") === 2, "USD two-decimal");
    assert(currencyExponent("XOF") === 0, "XOF zero-decimal (ISO-4217)");
    assert(currencyExponent("XAF") === 0, "XAF zero-decimal");
    assert(currencyExponent("JPY") === 0, "JPY zero-decimal");
    assert(currencyExponent("KWD") === 3, "KWD three-decimal");
    assert(isZeroDecimalCurrency("XOF") && !isZeroDecimalCurrency("NGN"), "zero-decimal predicate");

    // ── Conversions ───────────────────────────────────────────────────────
    assert(toMinorUnits(12.34, "NGN") === 1234, "₦12.34 → 1234 kobo");
    assert(toMinorUnits(100, "XOF") === 100, "100 XOF → 100 (no *100)");
    assert(toMinorUnits(1.234, "KWD") === 1234, "1.234 KWD → 1234 fils");
    assert(fromMinorUnits(1234, "NGN") === 12.34, "1234 kobo → ₦12.34");
    assert(fromMinorUnits(100, "XOF") === 100, "100 XOF round-trips");
    assert(minorUnitsEqual(100, 100.0, "XOF"), "XOF equality in whole units");
    assert(!minorUnitsEqual(100, 100.01, "NGN"), "1 kobo difference detected");

    // ── Dust policy: carry remainder + min-payout floor ───────────────────
    // ₦263.16 at 0.38 XOF/NGN = 100.0008 XOF — fractional dust.
    const dusty = applyDustPolicy({ amountMajor: 263.16, rate: 0.38, currency: "XOF" });
    assert(dusty.deliverableMinor === 100, `XOF deliverable floored to whole units (got ${dusty.deliverableMinor})`);
    assert(dusty.dustMinor > 0, "dust fraction returned for carrying (not dropped)");
    assert(!dusty.belowMinPayout, "100 XOF above the floor");
    // Below-floor: a near-zero conversion must be REFUSED, not truncated to 0.
    const dust = applyDustPolicy({ amountMajor: 0.001, rate: 0.38, currency: "XOF" });
    assert(dust.deliverableMinor === 0 && dust.belowMinPayout, "sub-unit XOF payout refused (below min floor)");
    const dustNgn = applyDustPolicy({ amountMajor: 0.0049, rate: 1, currency: "NGN" });
    assert(dustNgn.deliverableMinor === 0 && dustNgn.belowMinPayout, "sub-kobo payout refused");

    // ── Transfer path integration: XOF payout sends exponent-aware amount ──
    const { initiateTransfer } = await import("../../server/services/payments/paystackTransfer");
    const before = pay.calls.filter((c) => c.url.includes("/transfer")).length;
    const res = await initiateTransfer({
      secretKey: "sk_sim_j369",
      recipientCode: "RCP_sim_xof",
      amountMajor: 100,
      reason: "J369 XOF corridor",
      reference: `J369-${Date.now()}`,
      currency: "XOF",
    });
    assert(res.status === "success", "XOF transfer initiated in sim");
    const calls = pay.calls.slice(before).filter((c) => c.method === "POST" && c.url.endsWith("/transfer"));
    assert(calls.length === 1, "transfer POST recorded");
    assert(calls[0].body?.amount === 100, `XOF transfer amount=100 minor units, NOT 10000 (got ${calls[0].body?.amount})`);
    assert(calls[0].body?.currency === "XOF", "XOF currency passed through");
  },
};
