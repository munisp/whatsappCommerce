// === W48 api-db ===
/**
 * J468 — PERF-API-2: paymentConfirm minimal perf edit preserves money
 * semantics (claim-first, idempotency, verify-before-mutate) while the
 * maybe* hooks run in parallel and the WA receipt send is post-commit /
 * fire-and-forget.
 *
 * Proves through the REAL confirmProviderPayment:
 *   1. first confirm transitions the intent + confirms the order + creates
 *      the escrow hold exactly once,
 *   2. an immediate second confirm (the replay/race path that now runs the
 *      four maybe* hooks via Promise.allSettled) returns already-completed
 *      and creates NOTHING twice,
 *   3. an amount-mismatched confirm is still REJECTED before any state
 *      mutation (verify-before-compensate intact),
 *   4. confirm returns without waiting on the receipt send (the Meta call is
 *      no longer in-band — sim has no Graph endpoint, so an in-band send
 *      would have thrown/slowed the path; fire-and-forget logs instead).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J468",
  name: "paymentConfirm parallel hooks + post-commit receipt, semantics intact (PERF-API-2)",
  feature: "claim-first confirm idempotent; escrow hold exactly once; amount mismatch rejected before mutation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { confirmProviderPayment } = await import("../../server/services/paymentConfirm");

    const ref = `w48-j468-${Math.random().toString(36).slice(2, 10)}`;
    const orderId = `ord-j468-${ref.slice(-8)}`;
    const now = new Date();
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "sim-customer",
      orderNumber: `J468-${ref.slice(-6)}`,
      status: "pending",
      totalAmount: "900.00",
      currency: "NGN",
      paymentStatus: "unpaid",
      metadata: {},
    });
    await world.db.insert(schema.paymentIntents).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      orderId,
      customerId: "sim-customer",
      amount: "900.00",
      currency: "NGN",
      provider: "paystack",
      status: "initiated",
      providerPaymentId: ref,
      idempotencyKey: `seed:${ref}`,
      createdAt: now,
      updatedAt: now,
    });

    // 1. First confirm — claim-first transition.
    const t0 = Date.now();
    const r1 = await confirmProviderPayment(world.db, {
      provider: "paystack", reference: ref, amountMajor: 900, currency: "NGN", rawPayload: { sim: true },
    });
    const confirmMs = Date.now() - t0;
    assert(r1.ok && r1.action === "confirmed", `first confirm → confirmed (got ${JSON.stringify(r1)})`);
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(ord?.status === "confirmed" && ord?.paymentStatus === "completed", "order confirmed");
    const esc1 = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.orderId, orderId));
    assert(esc1.length === 1 && esc1[0].state === "escrow_held", "escrow hold created once");

    // 2. Replay — parallel maybe* path must be a no-op (already-completed).
    const r2 = await confirmProviderPayment(world.db, {
      provider: "paystack", reference: ref, amountMajor: 900, currency: "NGN", rawPayload: { sim: true },
    });
    assert(r2.ok && r2.action === "already-completed", `replay → already-completed (got ${JSON.stringify(r2)})`);
    const esc2 = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.orderId, orderId));
    assert(esc2.length === 1, "no duplicate escrow hold on replay");

    // 3. Amount mismatch rejected BEFORE mutation (separate intent).
    const ref3 = `w48-j468b-${Math.random().toString(36).slice(2, 8)}`;
    const orderId3 = `ord-j468b-${ref3.slice(-6)}`;
    await world.db.insert(schema.orders).values({
      id: orderId3, tenantId: TENANT_ID, customerId: "sim-customer",
      orderNumber: `J468B-${ref3.slice(-4)}`, status: "pending", totalAmount: "500.00",
      currency: "NGN", paymentStatus: "unpaid", metadata: {},
    });
    await world.db.insert(schema.paymentIntents).values({
      id: randomUUID(), tenantId: TENANT_ID, orderId: orderId3, customerId: "sim-customer",
      amount: "500.00", currency: "NGN", provider: "paystack", status: "initiated",
      providerPaymentId: ref3, idempotencyKey: `seed:${ref3}`, createdAt: now, updatedAt: now,
    });
    const r3 = await confirmProviderPayment(world.db, {
      provider: "paystack", reference: ref3, amountMajor: 500.01, currency: "NGN", rawPayload: { sim: true },
    });
    assert(!r3.ok && r3.action === "amount-currency-mismatch", "mismatch rejected (exact minor-unit compare)");
    const [ord3] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId3)).limit(1);
    assert(ord3?.status === "pending" && ord3?.paymentStatus === "unpaid", "rejected payment never confirms the order");
    const esc3 = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.orderId, orderId3));
    assert(esc3.length === 0, "rejected payment creates no escrow hold");

    // 4. The receipt send is post-commit/fire-and-forget: confirm returned
    //    without a Graph endpoint configured and without hanging.
    assert(confirmMs < 5000, `confirm did not block on the receipt send (${confirmMs}ms)`);
    await world.settle(300);
  },
};
