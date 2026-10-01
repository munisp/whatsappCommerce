// === W48 api-db ===
/**
 * J467 — PERF-API-1 / PERF-INT-1: PSP webhooks ack 200 FIRST, process post-ack.
 *
 * The /api/webhooks/paystack charge.success and /api/webhooks/flutterwave
 * charge.completed handlers previously awaited the full confirm chain + up to
 * 7 serial post-confirm hooks BEFORE res.status(200) — retry-storm bait.
 * Now the ack is the FIRST thing after HMAC verification (mirroring the WA
 * webhook pattern); confirmProviderPayment (claim-first/idempotent) + hooks
 * run post-ack.
 *
 * This journey proves, through the REAL HTTP handlers:
 *   1. ack body is the lean `{ received: true }` shape (no confirm result
 *      spread — processing has not happened at ack time),
 *   2. ack latency is small (< 2000ms even in-sim; the budget is <100ms of
 *      in-ack work in prod),
 *   3. the payment still confirms post-ack (order confirmed, intent
 *      completed) — dedupe/money semantics intact,
 *   4. a redelivery is idempotent (no double escrow hold).
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

async function seedPendingIntent(world: World, provider: string, reference: string, amount: string) {
  const schema = await import("../../drizzle/schema");
  const orderId = `ord-j467-${reference.slice(-8)}`;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: "sim-customer",
    orderNumber: `J467-${reference.slice(-6)}`,
    status: "pending",
    totalAmount: amount,
    currency: "NGN",
    paymentStatus: "unpaid",
    metadata: {},
  });
  await world.db.insert(schema.paymentIntents).values({
    id: randomUUID(),
    tenantId: TENANT_ID,
    orderId,
    customerId: "sim-customer",
    amount,
    currency: "NGN",
    provider,
    status: "initiated",
    providerPaymentId: reference,
    idempotencyKey: `seed:${reference}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { orderId };
}

async function paystackCharge(world: World, reference: string, amountMajor: number) {
  const raw = JSON.stringify({
    event: "charge.success",
    data: { reference, amount: Math.round(amountMajor * 100), currency: "NGN", status: "success" },
  });
  const sig = createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET ?? "").update(raw).digest("hex");
  const t0 = Date.now();
  const res = await fetch(`${world.baseUrl}/api/webhooks/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
    body: raw,
  });
  const ackMs = Date.now() - t0;
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ackMs };
}

async function flutterwaveCharge(world: World, txRef: string, amountMajor: number) {
  const raw = JSON.stringify({
    event: "charge.completed",
    data: { status: "successful", tx_ref: txRef, amount: amountMajor, currency: "NGN" },
  });
  const t0 = Date.now();
  const res = await fetch(`${world.baseUrl}/api/webhooks/flutterwave`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "verif-hash": process.env.FLW_WEBHOOK_SECRET ?? "" },
    body: raw,
  });
  const ackMs = Date.now() - t0;
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ackMs };
}

export const journey: Journey = {
  id: "J467",
  name: "PSP webhooks ack-first, process post-ack (PERF-API-1/INT-1)",
  feature: "paystack + flutterwave charge webhooks ack 200 before confirm+hooks; confirm still lands; redelivery idempotent",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── Paystack ─────────────────────────────────────────────────────────
    const ref1 = `w48-j467-ps-${Math.random().toString(36).slice(2, 8)}`;
    const { orderId: order1 } = await seedPendingIntent(world, "paystack", ref1, "1250.00");
    const r1 = await paystackCharge(world, ref1, 1250.0);
    assert(r1.status === 200, `paystack ack status 200 (got ${r1.status})`);
    assert(r1.json?.received === true, "paystack ack body {received:true}");
    assert(r1.json?.action === undefined, "ack-first: confirm result NOT spread into the ack body");
    assert(r1.ackMs < 2000, `ack fast (${r1.ackMs}ms < 2000ms in-sim bound)`);
    await world.settle(800);
    const [intent1] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, ref1)).limit(1);
    assert(intent1?.status === "completed", "paystack intent confirmed post-ack");
    const [ord1] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order1)).limit(1);
    assert(ord1?.status === "confirmed" && ord1?.paymentStatus === "completed", "order confirmed post-ack");

    // Redelivery idempotency: same webhook again → still one escrow hold.
    const r1b = await paystackCharge(world, ref1, 1250.0);
    assert(r1b.status === 200, "paystack redelivery acked 200");
    await world.settle(800);
    const escrows = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order1));
    assert(escrows.length === 1, `exactly one escrow hold after redelivery (got ${escrows.length})`);

    // ── Flutterwave ──────────────────────────────────────────────────────
    const ref2 = `w48-j467-flw-${Math.random().toString(36).slice(2, 8)}`;
    const { orderId: order2 } = await seedPendingIntent(world, "flutterwave", ref2, "640.00");
    const r2 = await flutterwaveCharge(world, ref2, 640.0);
    assert(r2.status === 200, `flutterwave ack status 200 (got ${r2.status})`);
    assert(r2.json?.received === true && r2.json?.action === undefined, "flutterwave ack-first shape");
    assert(r2.ackMs < 2000, `flutterwave ack fast (${r2.ackMs}ms)`);
    await world.settle(800);
    const [intent2] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, ref2)).limit(1);
    assert(intent2?.status === "completed", "flutterwave intent confirmed post-ack");
    const [ord2] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order2)).limit(1);
    assert(ord2?.status === "confirmed", "flutterwave order confirmed post-ack");

    // ── Bad signature still rejected pre-ack (fail-closed verification) ──
    process.env.PAYSTACK_WEBHOOK_SECRET = "j467-secret";
    try {
      const raw = JSON.stringify({ event: "charge.success", data: { reference: "nope", amount: 1 } });
      const bad = await fetch(`${world.baseUrl}/api/webhooks/paystack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paystack-signature": createHmac("sha512", "attacker").update(raw).digest("hex") },
        body: raw,
      });
      assert(bad.status === 401, "invalid HMAC still rejected 401 pre-ack");
      const good = await fetch(`${world.baseUrl}/api/webhooks/paystack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paystack-signature": createHmac("sha512", "j467-secret").update(raw).digest("hex") },
        body: raw,
      });
      assert(good.status === 200, "valid HMAC acked 200");
    } finally {
      delete process.env.PAYSTACK_WEBHOOK_SECRET;
    }
  },
};
