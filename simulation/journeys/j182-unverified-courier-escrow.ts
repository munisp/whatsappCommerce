/**
 * J182 — W30 hotfix (verify-v1 #11): mock/local/merchant-self-reported
 * courier delivery must NEVER auto-settle real escrow in production.
 *
 * Before this fix a merchant could book the built-in local_dispatch mock
 * courier, self-advance the shipment to "delivered", and the SLA scan /
 * auto-confirm cron would settle real escrow — a self-release chain with no
 * independent delivery evidence.
 *
 * Fix under test:
 *  - courier adapters declare `escrowTrusted` (local_dispatch / moto stub =
 *    false — fail-closed default);
 *  - in production-like envs, applyDeliveryStatus("delivered") from an
 *    untrusted courier still advances the order/escrow (the REAL buyer can
 *    confirm) but flags escrow metadata.buyerProtection="courier_unverified";
 *  - runSlaScan and the /api/scheduled/escrow-auto-confirm cron SKIP + ALERT
 *    flagged escrows — they never auto-settle them;
 *  - non-production keeps the current (unflagged) behavior for the sim.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

async function paidEscrow(world: World, phone: string) {
  const schema = await import("../../drizzle/schema");
  await world.grantConsent(phone);
  const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
  assert(order.paymentRef, "payment reference captured");
  const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
  assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
  let escrow: any | null = null;
  await world.waitFor(async () => {
    const [e] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    escrow = e ?? null;
    return !!escrow && escrow.state === "escrow_held";
  }, 10000, "escrow hold created in escrow_held");
  return { order, escrow: escrow! };
}

async function seedBookedDelivery(world: World, orderId: string, courier: string) {
  const schema = await import("../../drizzle/schema");
  const id = crypto.randomUUID();
  await world.db.insert(schema.deliveries).values({
    id, tenantId: TENANT_ID, orderId, courier,
    externalId: `ld-j182-${id.slice(0, 8)}`,
    status: "in_transit", feeCents: 35_000, currency: "NGN",
    statusHistory: [{ status: "booked", at: new Date().toISOString() }],
    bookedAt: new Date(),
  });
  return id;
}

export const journey: Journey = {
  id: "J182",
  name: "unverified courier delivery never auto-settles escrow in prod",
  feature: "W30 hotfix courier escrowTrusted flag + scan/cron skip",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { applyDeliveryStatus } = await import("../../server/services/delivery/service");
    const { runSlaScan } = await import("../../server/routers/sla");
    const { localDispatchAdapter } = await import("../../server/services/delivery/localDispatch");
    const { motoDispatchStubAdapter } = await import("../../server/services/delivery/motoDispatchStub");
    const { getDb } = await import("../../server/db");
    const db = (await getDb()) as any;

    // Adapters are honestly labelled untrusted (fail-closed default).
    assert(localDispatchAdapter.escrowTrusted === false, "local_dispatch honestly untrusted for escrow");
    assert(motoDispatchStubAdapter.escrowTrusted === false, "moto stub honestly untrusted for escrow");

    // ── Part A: PRODUCTION — merchant self-advances mock-courier delivery ─
    const a = await paidEscrow(world, world.newPhone("ucourier-prod"));
    const deliveryA = await seedBookedDelivery(world, a.order.orderId, "local_dispatch");

    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const adv = await applyDeliveryStatus(db, deliveryA, { status: "delivered" });
      assert(adv.transitioned === true, "delivery row still advances (shipment marked delivered)");
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // Order is delivered; escrow advanced to delivery_confirmed but FLAGGED.
    const [ordA] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, a.order.orderId)).limit(1);
    assert(ordA.status === "delivered", `order delivered (got ${ordA.status})`);
    const [escA1] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, a.escrow.id)).limit(1);
    assert(escA1.state === "delivery_confirmed", `escrow advanced for buyer confirm (got ${escA1.state})`);
    const metaA = (escA1.metadata ?? {}) as Record<string, unknown>;
    assert(metaA.buyerProtection === "courier_unverified",
      `escrow flagged courier_unverified (got ${JSON.stringify(metaA.buyerProtection)})`);

    // Deadline in the past → SLA scan must SKIP + ALERT, never settle.
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.escrowTransactions.id, a.escrow.id));
    const scan = await runSlaScan();
    assert(scan.skippedCourierUnverified >= 1,
      `scan skipped unverified-courier escrow (got ${scan.skippedCourierUnverified})`);
    const [escA2] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, a.escrow.id)).limit(1);
    assert(escA2.state === "delivery_confirmed", `SLA scan did NOT settle (got ${escA2.state})`);

    // Auto-confirm cron must also skip it.
    const cron = await world.runCron("/api/scheduled/escrow-auto-confirm");
    assert(cron.status === 200, `cron accepted (got ${cron.status})`);
    const [escA3] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, a.escrow.id)).limit(1);
    assert(escA3.state === "delivery_confirmed", `auto-confirm cron did NOT settle (got ${escA3.state})`);
    assert(!escA3.merchantWalletTxId, "no merchant wallet credit from auto paths");

    // Cleanup: move the deadline far into the future so later journeys'
    // scans/crons leave this flagged escrow untouched.
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() + 72 * 3600_000) })
      .where(eq(schema.escrowTransactions.id, a.escrow.id));

    // ── Part B: NON-PROD — sim behavior unchanged (no flag) ─────────────
    const b = await paidEscrow(world, world.newPhone("ucourier-sim"));
    const deliveryB = await seedBookedDelivery(world, b.order.orderId, "local_dispatch");
    const advB = await applyDeliveryStatus(db, deliveryB, { status: "delivered" });
    assert(advB.transitioned === true, "non-prod delivery advances");
    const [escB] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, b.escrow.id)).limit(1);
    assert(escB.state === "delivery_confirmed", `non-prod escrow advanced (got ${escB.state})`);
    const metaB = (escB.metadata ?? {}) as Record<string, unknown>;
    assert(metaB.buyerProtection !== "courier_unverified", "non-prod keeps current behavior (no flag)");

    // Non-prod cleanup: cancel B's order so later SLA scans refund it.
    await world.db.update(schema.orders).set({ status: "cancelled" })
      .where(eq(schema.orders.id, b.order.orderId));
  },
};
