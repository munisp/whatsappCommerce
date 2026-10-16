// === W54 disputes ===
/**
 * J547 — DISP-2: chargeback–escrow interlock.
 *  1. charge.dispute.create (open) freezes the order's escrow via the SAME
 *     atomic guard as the dispute-raise path (escrow_held → dispute_raised) —
 *     payout is blocked while the PSP dispute is fought.
 *  2. Webhook redelivery stays idempotent: one payment_disputes row, escrow
 *     untouched on replay (guarded UPDATE matches 0 rows).
 *  3. charge.dispute.resolve (lost) records a merchant_clawbacks recovery
 *     entry (pending, refundId `psp-dispute:<id>` — ON CONFLICT DO NOTHING
 *     idempotent) + admin alert. Money is NEVER moved speculatively.
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ADMIN_PHONE, TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

async function paystackEvent(world: World, event: string, data: Record<string, unknown>) {
  const raw = JSON.stringify({ event, data });
  const sig = createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET ?? "").update(raw).digest("hex");
  const res = await fetch(`${world.baseUrl}/api/webhooks/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
    body: raw,
  });
  const json = await res.json().catch(() => null);
  await world.settle(400);
  return { status: res.status, json };
}

export const journey: Journey = {
  id: "J547",
  name: "DISP-2: chargeback freezes escrow + idempotent replay + lost recovery entry",
  feature: "W54 chargeback-escrow interlock + lost-chargeback recovery",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();

    // Seed: paid order + payment intent + ACTIVE escrow (escrow_held).
    const ref = `w54-j547-${Math.random().toString(36).slice(2, 10)}`;
    const orderId = `ord-j547-${ref.slice(-8)}`;
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: "sim-customer",
      orderNumber: `J547-${ref.slice(-6)}`, status: "confirmed",
      totalAmount: "1250.00", currency: "NGN", paymentStatus: "completed", metadata: {},
    });
    await world.db.insert(schema.paymentIntents).values({
      id: randomUUID(), tenantId: TENANT_ID, orderId, customerId: "sim-customer",
      amount: "1250.00", currency: "NGN", provider: "paystack", status: "completed",
      providerPaymentId: ref, idempotencyKey: `seed:${ref}`, completedAt: now, createdAt: now, updatedAt: now,
    });
    const escrowId = randomUUID();
    await world.db.insert(schema.escrowTransactions).values({
      id: escrowId, tenantId: TENANT_ID, orderId, customerId: "sim-customer",
      amount: "1250.00", currency: "NGN", state: "escrow_held",
    });

    // ── 1. open dispute → escrow frozen (guarded transition) ─────────────
    const d1 = await paystackEvent(world, "charge.dispute.create", {
      id: 910001, status: "awaiting-merchant-feedback", currency: "NGN",
      refund_amount: 125_000, transaction: { reference: ref, amount: 125_000 },
    });
    assert(d1.status === 200 && d1.json?.action === "recorded", `dispute recorded (got ${JSON.stringify(d1.json)})`);
    const [e1] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrowId));
    assert(e1.state === "dispute_raised", `escrow frozen while chargeback open (got ${e1.state})`);
    await world.waitFor(
      () => world.outbound.toPhone(ADMIN_PHONE).map((c) => bodyText(c)).join("\n").includes("FROZEN"),
      8000, "admin escrow-frozen alert");

    // ── 2. redelivery idempotent ──────────────────────────────────────────
    const d1b = await paystackEvent(world, "charge.dispute.create", {
      id: 910001, status: "awaiting-merchant-feedback", currency: "NGN",
      refund_amount: 125_000, transaction: { reference: ref, amount: 125_000 },
    });
    assert(d1b.status === 200 && d1b.json?.action === "updated", "redelivery acked as update");
    const rows = await world.db.select().from(schema.paymentDisputes)
      .where(and(eq(schema.paymentDisputes.providerRef, ref), eq(schema.paymentDisputes.provider, "paystack")));
    assert(rows.length === 1, `still one dispute row (got ${rows.length})`);
    const [e2] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrowId));
    assert(e2.state === "dispute_raised", "replay does not re-freeze / corrupt the escrow");

    // ── 3. lost → recovery entry + alert (no speculative money movement) ──
    const disputeId = rows[0].id;
    const d2 = await paystackEvent(world, "charge.dispute.resolve", {
      id: 910001, resolution: "lost", currency: "NGN",
      refund_amount: 125_000, transaction: { reference: ref, amount: 125_000 },
    });
    assert(d2.status === 200, `resolve acked (got ${d2.status})`);
    const clawbackKey = `cb:${String(disputeId).replace(/-/g, "")}`.slice(0, 36);
    const clawbacks = await world.db.select().from(schema.merchantClawbacks)
      .where(eq(schema.merchantClawbacks.refundId, clawbackKey));
    assert(clawbacks.length === 1, `exactly one recovery entry (got ${clawbacks.length})`);
    assert((clawbacks[0].metadata as any)?.disputeId === disputeId, "recovery entry links the full dispute id");
    assert(clawbacks[0].amountCents === 125_000 && clawbacks[0].status === "pending",
      `recovery entry pending for the lost amount (got ${clawbacks[0].amountCents}/${clawbacks[0].status})`);
    await world.waitFor(
      () => world.outbound.toPhone(ADMIN_PHONE).map((c) => bodyText(c)).join("\n").includes("recovery"),
      8000, "admin lost-chargeback recovery alert");
    const alertText = world.outbound.toPhone(ADMIN_PHONE).map((c) => bodyText(c)).join("\n");
    assertIncludes(alertText, "lost", "alert names the lost chargeback");

    // Lost redelivery: still exactly one recovery entry (ON CONFLICT DO NOTHING).
    await paystackEvent(world, "charge.dispute.resolve", {
      id: 910001, resolution: "lost", currency: "NGN",
      refund_amount: 125_000, transaction: { reference: ref, amount: 125_000 },
    });
    const clawbacks2 = await world.db.select().from(schema.merchantClawbacks)
      .where(eq(schema.merchantClawbacks.refundId, clawbackKey));
    assert(clawbacks2.length === 1, "lost redelivery does not duplicate the recovery entry");
  },
};
