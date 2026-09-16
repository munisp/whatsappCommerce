/**
 * === W39 PAY-8 ===
 * J271 — PSP dispute/refund webhook events are no longer silently dropped.
 *
 * Through the REAL /api/webhooks/paystack handler:
 *   1. charge.dispute.create → payment_disputes row (open), the order is
 *      flagged (metadata.dispute), and the tenant admin gets a WhatsApp
 *      alert. Redelivery of the same dispute event stays idempotent
 *      (one row, updated — no duplicate records).
 *   2. refund.processed → the matching W38 refund_attempts row is confirmed
 *      (status 'processed').
 *   3. refund.failed → the attempt is marked 'failed' AND the admin is
 *      alerted (a failed provider refund must never be silent — the customer
 *      has not been refunded).
 *   4. An unknown event type is still 200-acked (PSP contract) — handled
 *      events prove the ack is not a bare catch-all.
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ADMIN_PHONE, TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

async function paystackEvent(world: World, event: string, data: Record<string, unknown>): Promise<{ status: number; json: any }> {
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
  id: "J271",
  name: "PSP dispute + refund-status webhooks (PAY-8)",
  feature: "charge.dispute → payment_disputes + order flag + admin alert; refund.processed/failed reconcile refund_attempts; unknown events acked",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();

    // ── Seed: a completed paystack payment against a real order ──────────
    const ref = `w39-j271-${Math.random().toString(36).slice(2, 10)}`;
    const orderId = `ord-j271-${ref.slice(-8)}`;
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "sim-customer",
      orderNumber: `J271-${ref.slice(-6)}`,
      status: "pending",
      totalAmount: "1250.00",
      currency: "NGN",
      paymentStatus: "completed",
      metadata: {},
    });
    await world.db.insert(schema.paymentIntents).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      orderId,
      customerId: "sim-customer",
      amount: "1250.00",
      currency: "NGN",
      provider: "paystack",
      status: "completed",
      providerPaymentId: ref,
      idempotencyKey: `seed:${ref}`,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // ── 1. charge.dispute.create → dispute row + order flag + alert ──────
    const adminBase = world.outbound.toPhone(ADMIN_PHONE).length;
    const d1 = await paystackEvent(world, "charge.dispute.create", {
      id: 900001,
      status: "awaiting-merchant-feedback",
      currency: "NGN",
      refund_amount: 125_000, // kobo == cents
      transaction: { reference: ref, amount: 125_000 },
    });
    assert(d1.status === 200 && d1.json?.received === true, `dispute webhook acked (got ${d1.status})`);
    assert(d1.json?.action === "recorded", `dispute recorded (got ${JSON.stringify(d1.json)})`);

    const disputes = await world.db.select().from(schema.paymentDisputes)
      .where(and(eq(schema.paymentDisputes.providerRef, ref), eq(schema.paymentDisputes.provider, "paystack")));
    assert(disputes.length === 1, `exactly one dispute row (got ${disputes.length})`);
    assert(disputes[0].kind === "dispute" && disputes[0].status === "open", `dispute open (got ${disputes[0].kind}/${disputes[0].status})`);
    assert(disputes[0].tenantId === TENANT_ID && disputes[0].orderId === orderId, "dispute resolved to tenant + order");
    assert(disputes[0].amountCents === 125_000, `dispute amount in cents (got ${disputes[0].amountCents})`);

    const [flagged] = await world.db.select({ metadata: schema.orders.metadata })
      .from(schema.orders).where(eq(schema.orders.id, orderId));
    assert((flagged?.metadata as any)?.dispute?.status === "open", "order flagged with dispute metadata");

    await world.waitFor(
      () => world.outbound.toPhone(ADMIN_PHONE).length > adminBase,
      8000, "admin WhatsApp dispute alert",
    );
    const alertText = world.outbound.toPhone(ADMIN_PHONE).slice(adminBase).map((c) => bodyText(c)).join("\n");
    assertIncludes(alertText, "dispute", "admin alert names the dispute");

    // Redelivery (PSP retry) — same event must NOT duplicate the record.
    const d1b = await paystackEvent(world, "charge.dispute.create", {
      id: 900001,
      status: "awaiting-merchant-feedback",
      currency: "NGN",
      refund_amount: 125_000,
      transaction: { reference: ref, amount: 125_000 },
    });
    assert(d1b.status === 200, "dispute redelivery acked");
    const disputesAfter = await world.db.select().from(schema.paymentDisputes)
      .where(and(eq(schema.paymentDisputes.providerRef, ref), eq(schema.paymentDisputes.provider, "paystack")));
    assert(disputesAfter.length === 1, `redelivery idempotent — still one row (got ${disputesAfter.length})`);

    // ── 2. refund.processed confirms the W38 refund_attempts row ─────────
    const refOk = `${ref}-refund-ok`;
    await world.db.insert(schema.refundAttempts).values({
      tenantId: TENANT_ID,
      orderId,
      provider: "paystack",
      providerRef: refOk,
      idempotencyKey: `idem:${refOk}`,
      amountCents: 50_000,
      currency: "NGN",
      status: "pending",
      createdAt: now,
    });
    const r1 = await paystackEvent(world, "refund.processed", { reference: refOk, amount: 50_000, currency: "NGN" });
    assert(r1.status === 200 && r1.json?.action === "confirmed", `refund.processed confirmed (got ${JSON.stringify(r1.json)})`);
    const [okAttempt] = await world.db.select().from(schema.refundAttempts)
      .where(eq(schema.refundAttempts.providerRef, refOk));
    assert(okAttempt?.status === "processed", `attempt marked processed (got ${okAttempt?.status})`);

    // ── 3. refund.failed marks failed + alerts the admin ──────────────────
    const refBad = `${ref}-refund-bad`;
    await world.db.insert(schema.refundAttempts).values({
      tenantId: TENANT_ID,
      orderId,
      provider: "paystack",
      providerRef: refBad,
      idempotencyKey: `idem:${refBad}`,
      amountCents: 75_000,
      currency: "NGN",
      status: "pending",
      createdAt: now,
    });
    const adminBase2 = world.outbound.toPhone(ADMIN_PHONE).length;
    const r2 = await paystackEvent(world, "refund.failed", { reference: refBad, amount: 75_000, currency: "NGN" });
    assert(r2.status === 200 && r2.json?.action === "marked-failed", `refund.failed marked (got ${JSON.stringify(r2.json)})`);
    const [badAttempt] = await world.db.select().from(schema.refundAttempts)
      .where(eq(schema.refundAttempts.providerRef, refBad));
    assert(badAttempt?.status === "failed", `attempt marked failed (got ${badAttempt?.status})`);
    await world.waitFor(
      () => world.outbound.toPhone(ADMIN_PHONE).length > adminBase2,
      8000, "admin WhatsApp refund-failure alert",
    );
    const failAlert = world.outbound.toPhone(ADMIN_PHONE).slice(adminBase2).map((c) => bodyText(c)).join("\n");
    assertIncludes(failAlert, "Refund FAILED", "admin alert names the failed refund");

    // ── 4. Unknown event type: still acked (never a silent 5xx/drop) ──────
    const u = await paystackEvent(world, "invoice.payment_failed", { reference: ref });
    assert(u.status === 200 && u.json?.received === true, `unknown event acked (got ${u.status})`);
  },
};
