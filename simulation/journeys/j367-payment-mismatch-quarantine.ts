// === W45 money-intents (Coder B2) ===
/**
 * J367 — PAY-13: PSP under/overpayment with money in hand is QUARANTINED.
 *
 * A Paystack charge.success webhook arrives for MORE than the intent amount:
 * the pinned paymentConfirm.ts marks the intent failed (mismatch), and the
 * W45 adjacent seam then (a) inserts a payment_mismatch_quarantine row,
 * (b) fires a CRITICAL ops alert, and (c) auto-refunds the ACTUAL collected
 * amount via the provider refund API (refund_attempts journaled). A replayed
 * webhook never double-refunds (reference-unique idempotency).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J367",
  name: "PAY-13: payment mismatch quarantine + ops alert + auto-refund",
  feature: "W45 paymentMismatchQuarantine adjacent seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { getRecentErrors, _resetRecentErrors } = await import("../../server/services/observability");
    _resetRecentErrors();

    // Refund-capable provider chain for the tenant (env default chain has no
    // refund capability wiring in refunds.ts — it uses the registry).
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    await upsertTenantProviderConfig({
      tenantId: TENANT_ID,
      provider: "paystack",
      creds: { secretKey: "sk_sim_j367" },
      priority: 10,
    });

    const phone = world.newPhone("pay13");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    assert(order.paymentRef, "order has a payment reference");

    // Webhook reports ₦500 MORE than the intent — money in hand, wrong amount.
    const overpaid = order.total + 500;
    const res = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: overpaid });
    assert(res.status === 200, `webhook acked (got ${res.status})`);

    // Pinned behavior: the payment record failed on mismatch (chat checkout
    // records live in payment_transactions keyed by providerRef).
    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.providerRef, order.paymentRef!)).limit(1);
    assert(tx, "payment transaction exists for the reference");
    assert(tx.status === "failed", `mismatched payment failed (got ${tx.status})`);

    // (a) Quarantine row exists with expected vs actual minor units.
    const [q] = await world.db.select().from(schema.paymentMismatchQuarantine)
      .where(eq(schema.paymentMismatchQuarantine.reference, order.paymentRef!)).limit(1);
    assert(q, "quarantine row inserted");
    assert(q.tenantId === TENANT_ID, "quarantine tenant-scoped");
    assert(q.expectedAmountMinor === Math.round(order.total * 100), `expected minor ${q.expectedAmountMinor}`);
    assert(q.actualAmountMinor === Math.round(overpaid * 100), `actual minor ${q.actualAmountMinor}`);
    assert(q.orderId === order.orderId, "quarantine links the order");

    // (b) Ops alert fired (critical capture).
    const alerts = getRecentErrors(50).filter(
      (e) => e.service === "payments/paymentMismatchQuarantine" && e.severity === "critical",
    );
    assert(alerts.length >= 1, "critical ops alert captured");

    // (c) Auto-refund of the ACTUAL collected amount via the provider.
    assert(q.status === "auto_refund_initiated" || q.status === "auto_refund_paid", `auto-refund tracked (got ${q.status})`);
    const attempts = await world.db.select().from(schema.refundAttempts)
      .where(eq(schema.refundAttempts.orderId, order.orderId));
    const refundAttempt = attempts.find((a) => a.amountCents === Math.round(overpaid * 100));
    assert(refundAttempt, "refund attempt journaled for the actual amount");

    // Replay the same webhook → NO second quarantine row, NO second refund.
    await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: overpaid });
    const rows = await world.db.select().from(schema.paymentMismatchQuarantine)
      .where(eq(schema.paymentMismatchQuarantine.reference, order.paymentRef!));
    assert(rows.length === 1, "webhook replay did not double-quarantine");
    const attemptsAfter = await world.db.select().from(schema.refundAttempts)
      .where(eq(schema.refundAttempts.orderId, order.orderId));
    assert(attemptsAfter.length === attempts.length, "webhook replay did not double-refund");
  },
};
