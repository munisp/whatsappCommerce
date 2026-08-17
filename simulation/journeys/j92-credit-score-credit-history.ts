/**
 * J92 — Credit-outcome-aware scoring (W18): a buyer's platform credit history
 * moves the deterministic score AND the risk-based terms band.
 *
 *   1. Buyer A: baseline suggestion (no credit history) → three facilities
 *      drawn and repaid ON TIME (real applyRepayment seam, FIFO settlement)
 *      → the next suggestion scores higher (credit history is the dominant
 *      signal) and the terms band improves (21d/2.5% → 30d/1.5%).
 *   2. Buyer B: identical platform history but three LATE repayments
 *      (dunning fee markers on the draws), cured back to zero → the score
 *      drops and the terms degrade (21d/2.5% → 14d/3.5%).
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID } from "../world";
import { adminCaller } from "./helpers";

const HOUR_MS = 60 * 60 * 1000;

export const journey: Journey = {
  id: "J92",
  name: "credit score sees credit history",
  feature: "credit-outcome scoring + risk-based terms bands",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { suggestLimit, applyRepayment } = await import("../../server/services/tradeCredit");
    const admin = await adminCaller();

    // Shared platform-history fixture: ₦1,000,000 30-day volume + one
    // on-time payment → baseline score 56 (21d tenor, 2.5% fee band).
    const seedPlatformHistory = async (tenantId: string, tag: string) => {
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await world.db.insert(schema.orders).values({
          id: randomUUID(),
          tenantId,
          customerId: `j92-customer-${tag}-${i}`,
          orderNumber: `J92-${tag}-${now}-${i}`,
          status: "delivered",
          totalAmount: "500000.00",
          currency: "NGN",
        });
      }
      const created = new Date(now - 5 * 24 * HOUR_MS);
      await world.db.insert(schema.paymentTransactions).values({
        id: randomUUID(),
        tenantId,
        provider: "paystack",
        providerRef: `J92PAY-${tag}-${now}`,
        amount: "1000.00",
        currency: "NGN",
        status: "completed",
        createdAt: created,
        paidAt: new Date(created.getTime() + 1 * HOUR_MS),
      });
    };

    // Seed THREE facilities from THREE DIFFERENT suppliers (one account per
    // (supplier, buyer) pair is enforced by credit_accounts_pair_uniq — and
    // scoring is platform-wide, so cross-supplier history counts). Each
    // facility gets one posted ₦50,000 draw, repaid in full via the real
    // repayment seam (FIFO settle → outstanding back to zero).
    const buildHistory = async (
      buyerTenantId: string,
      tag: string,
      opts: { late: boolean },
    ) => {
      const drawAmount = 5_000_000;
      for (let i = 0; i < 3; i++) {
        const accountId = randomUUID();
        await world.db.insert(schema.creditAccounts).values({
          id: accountId,
          supplierTenantId: i === 0 ? SUPPLIER_TENANT_ID : `${SUPPLIER_TENANT_ID}-peer-${i}`,
          buyerTenantId,
          limitCents: 30_000_000,
          outstandingCents: drawAmount,
          termsDays: 14,
          status: "active",
        });
        await world.db.insert(schema.creditLedger).values({
          id: randomUUID(),
          creditAccountId: accountId,
          kind: "invoice_draw",
          amountCents: drawAmount,
          dueDate: opts.late
            ? new Date(Date.now() - 20 * 24 * HOUR_MS)
            : new Date(Date.now() + 14 * 24 * HOUR_MS),
          status: "posted",
          ref: `draw:po-j92-${tag}-${i}`,
          // Late path: the dunning sweep charged the 2% late fee (marker).
          note: opts.late ? `Late fee 2% [dun:fee]` : null,
        });
        const rep = await applyRepayment({
          accountId,
          amountCents: drawAmount,
          ref: `j92-${tag}-repay-${i}`,
        });
        assert(rep.ok === true && rep.outstandingAfter === 0, `${tag}-${i}: facility repaid to zero`);
        const settled = await world.db
          .select()
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.creditAccountId, accountId));
        assert(
          settled.filter((r) => r.kind === "invoice_draw").every((r) => r.status === "settled"),
          `${tag}-${i}: draw settled by the repayment`,
        );
      }
    };

    // ── 1. On-time history improves score AND terms ────────────────────────
    const buyerA = (await admin.onboarding.start({ name: "J92 Ontime Buyer" })).tenantId;
    await seedPlatformHistory(buyerA, "a");
    const baselineA = await suggestLimit(buyerA, SUPPLIER_TENANT_ID);
    assert(baselineA.score === 56, `baseline score 56 (got ${baselineA.score})`);
    assert(baselineA.terms.tenorDays === 21 && baselineA.terms.feeBps === 250, "baseline band 21d/2.5%");
    assert(!baselineA.reasons.some((r) => r.startsWith("credit:")), "no credit reasons at baseline");

    await buildHistory(buyerA, "a", { late: false });
    const improved = await suggestLimit(buyerA, SUPPLIER_TENANT_ID);
    assert(improved.score === 68, `on-time credit history raises score to 68 (got ${improved.score})`);
    assert(improved.score > baselineA.score, "score improves with on-time history");
    assert(
      improved.reasons.includes("credit: 3 facilities repaid on time"),
      `on-time reason surfaced (${JSON.stringify(improved.reasons)})`,
    );
    assert(
      improved.terms.tenorDays === 30 && improved.terms.feeBps === 150 && improved.terms.decline === false,
      `terms improve to 30d/1.5% (got ${JSON.stringify(improved.terms)})`,
    );
    assert(improved.suggestedLimitCents > baselineA.suggestedLimitCents, "suggested limit rises with trust");

    // ── 2. Late (then cured) history degrades score AND terms ──────────────
    const buyerB = (await admin.onboarding.start({ name: "J92 Late Buyer" })).tenantId;
    await seedPlatformHistory(buyerB, "b");
    const baselineB = await suggestLimit(buyerB, SUPPLIER_TENANT_ID);
    assert(baselineB.score === 56, `buyer B baseline score 56 (got ${baselineB.score})`);

    await buildHistory(buyerB, "b", { late: true });
    const degraded = await suggestLimit(buyerB, SUPPLIER_TENANT_ID);
    assert(degraded.score === 36, `late history drops score to 36 (got ${degraded.score})`);
    assert(degraded.score < baselineB.score, "score degrades with late repayments");
    assert(degraded.reasons.includes("credit: 3 late repayments"), "late-repayment reason surfaced");
    assert(
      degraded.reasons.includes("credit: recovered to zero after late repayment"),
      "cure-at-zero recovery reason surfaced",
    );
    assert(
      degraded.terms.tenorDays === 14 && degraded.terms.feeBps === 350 && degraded.terms.decline === false,
      `terms degrade to 14d/3.5% (got ${JSON.stringify(degraded.terms)})`,
    );
    assert(degraded.suggestedLimitCents < baselineB.suggestedLimitCents, "suggested limit shrinks");
  },
};
