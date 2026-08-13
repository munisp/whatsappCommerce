/**
 * J68 — Bureau event payloads & lifecycle (W14 F3). A full credit lifecycle
 * on a consented facility emits the bureau event sequence with correct
 * payload shapes, post-transaction and fire-and-forget:
 *   approve(consent) → draw (disbursement) → partial repay (repayment, no
 *   cure) → +3d dunning (delinquency/late_fee) → +7d dunning
 *   (delinquency/freeze + account frozen) → repay-to-zero (repayment + cure,
 *   suspension lifted) → supplier close (closure, reason supplier_close).
 * The default 'disabled' adapter leaves every row 'pending' (durable outbox,
 * zero network sends). With a provider configured but unreachable the row
 * flips to 'failed' and stays retryable.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { bureauLogRows, provisionCreditPair } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J68",
  name: "bureau event payloads & lifecycle",
  feature: "disbursement→repayment→delinquency→cure→closure payloads",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { drawOnCredit, applyRepayment, runDunningCheck } = await import("../../server/services/tradeCredit");

    const p = await provisionCreditPair(world, { userIdBase: 681, name: "J68 Life" });
    await p.supCaller.tradeCredit.approveAccount({
      supplierTenantId: p.sup,
      accountId: p.accountId,
      limitCents: 5_000_000,
      bureauConsent: true,
    });

    // ── Draw → disbursement payload ──────────────────────────────────────
    const draw = await drawOnCredit({
      supplierTenantId: p.sup,
      buyerTenantId: p.buy,
      amountCents: 2_000_000, // ₦20,000
      poId: "po-j68",
      termsDays: 14,
    });
    assert(draw.ok === true, "draw succeeds");
    let rows = await bureauLogRows(world, p.accountId);
    assert(rows.length === 1, "one disbursement event");
    const disb = rows[0];
    assert(disb.eventType === "disbursement" && disb.status === "pending" && disb.bureau === "disabled", "disbursement pending/disabled");
    const dp = disb.payload as any;
    assert(dp.amountCents === 2_000_000 && dp.currency === "NGN", "disbursement payload amount/currency");
    assert(dp.ledgerId === draw.ledgerId && dp.poId === "po-j68", "disbursement payload ledger/po refs");
    assert(typeof dp.dueDate === "string" && typeof dp.occurredAt === "string", "disbursement payload ISO dates");
    assert(dp.outstandingAfter === 2_000_000, "disbursement payload outstandingAfter");

    // ── Partial repayment → repayment payload, NO cure ───────────────────
    const partial = await applyRepayment({ accountId: p.accountId, amountCents: 500_000, ref: "repay:j68-partial" });
    assert(partial.ok === true && partial.outstandingAfter === 1_500_000, "partial repayment lands");
    rows = await bureauLogRows(world, p.accountId);
    assert(rows.length === 2, "partial repayment adds one event (no cure)");
    const rep1 = rows[1];
    assert(rep1.eventType === "repayment", "repayment event type");
    const rp = rep1.payload as any;
    assert(rp.amountCents === 500_000 && rp.ref === "repay:j68-partial" && rp.outstandingAfter === 1_500_000, "repayment payload shape");

    // ── Delinquency: +3d late_fee milestone ──────────────────────────────
    const t0 = new Date();
    await world.backdate(`UPDATE credit_ledger SET due_date = $1 WHERE id = $2`, [new Date(t0.getTime() - 3 * DAY_MS), draw.ledgerId]);
    const sweep1 = await runDunningCheck(t0);
    assert(sweep1.feesApplied === 1 && sweep1.frozen === 0, `+3d sweep applies the late fee (${JSON.stringify(sweep1)})`);
    rows = await bureauLogRows(world, p.accountId);
    assert(rows.length === 3 && rows[2].eventType === "delinquency", "+3d emits delinquency");
    const d1 = rows[2].payload as any;
    assert(d1.severity === "late_fee" && d1.drawId === draw.ledgerId && d1.daysOverdue >= 3, "late_fee delinquency payload");

    // ── Delinquency escalation: +7d freeze milestone ─────────────────────
    const t7 = new Date(t0.getTime() + 4 * DAY_MS); // offset +7 relative to due date
    const sweep2 = await runDunningCheck(t7);
    assert(sweep2.frozen === 1, `+7d sweep freezes the facility (${JSON.stringify(sweep2)})`);
    const [frozenRow] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, p.accountId)).limit(1);
    assert(frozenRow.status === "frozen" && frozenRow.suspended === true, "account frozen + order access suspended");
    rows = await bureauLogRows(world, p.accountId);
    assert(rows.length === 4 && rows[3].eventType === "delinquency", "+7d emits the escalation delinquency");
    const d2 = rows[3].payload as any;
    assert(d2.severity === "freeze" && d2.daysOverdue >= 7, "freeze delinquency payload");

    // ── Cure: repay to zero → repayment + cure, suspension lifted ────────
    const cured = await applyRepayment({ accountId: p.accountId, amountCents: 1_500_000, ref: "repay:j68-cure" });
    assert(cured.ok === true && cured.outstandingAfter === 0, "cure repayment lands");
    const [curedRow] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, p.accountId)).limit(1);
    assert(curedRow.suspended === false, "order-access suspension lifted on cure");
    rows = await bureauLogRows(world, p.accountId);
    assert(rows.length === 6, "cure adds repayment + cure events");
    assert(rows[4].eventType === "repayment" && rows[5].eventType === "cure", "repayment then cure");
    const curePayload = rows[5].payload as any;
    assert(typeof curePayload.occurredAt === "string", "cure payload carries occurredAt");

    // ── Closure via the supplier tRPC path ───────────────────────────────
    const closed = await p.supCaller.tradeCredit.setAccountStatus({
      supplierTenantId: p.sup,
      accountId: p.accountId,
      status: "closed",
    });
    assert(closed.status === "closed", "facility closed");
    rows = await bureauLogRows(world, p.accountId);
    assert(rows.length === 7 && rows[6].eventType === "closure", "closure event emitted");
    const cp = rows[6].payload as any;
    assert(cp.reason === "supplier_close" && cp.outstandingCents === 0, "closure payload shape");

    // Full sequence, all pending under the disabled provider (no sends).
    const seq = rows.map((r) => r.eventType).join(",");
    assert(
      seq === "disbursement,repayment,delinquency,delinquency,repayment,cure,closure",
      `full lifecycle sequence (got ${seq})`,
    );
    assert(rows.every((r) => r.status === "pending" && r.bureau === "disabled"), "disabled adapter: durable pending rows, zero sends");

    // ── Configured-but-failing provider → status 'failed', retryable ─────
    const q = await provisionCreditPair(world, { userIdBase: 683, name: "J68 Fail" });
    await q.supCaller.tradeCredit.approveAccount({
      supplierTenantId: q.sup,
      accountId: q.accountId,
      limitCents: 5_000_000,
      bureauConsent: true,
    });
    process.env.BUREAU_PROVIDER = "crc";
    process.env.BUREAU_API_BASE = "http://bureau.sim.local"; // unmocked host → fetch mock answers HTTP 400
    process.env.BUREAU_API_KEY = "sim-bureau-secret-key";
    try {
      const failDraw = await drawOnCredit({
        supplierTenantId: q.sup,
        buyerTenantId: q.buy,
        amountCents: 100_000,
        poId: "po-j68-fail",
        termsDays: 14,
      });
      assert(failDraw.ok === true, "bureau send failure never blocks the draw");
      const failRows = await bureauLogRows(world, q.accountId);
      assert(failRows.length === 1, "failed send still persisted the outbox row");
      assert(failRows[0].status === "failed" && failRows[0].bureau === "crc", "row flips to failed under the crc adapter");
      const errText = JSON.stringify(failRows[0].response ?? {});
      assert(/responded HTTP [45]\d\d/.test(errText), `failure response captured (got ${errText})`);
      assert(!errText.includes("sim-bureau-secret-key"), "API key redacted from the persisted error");
    } finally {
      delete process.env.BUREAU_PROVIDER;
      delete process.env.BUREAU_API_BASE;
      delete process.env.BUREAU_API_KEY;
    }
  },
};
