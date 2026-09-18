/**
 * === W43 exchanges (Coder B) ===
 * J327 — Exchange full lifecycle, POSITIVE price delta → payment link via the
 * REAL existing payment intent path (paymentIntents row + provider fallback;
 * paymentConfirm.ts untouched). Walks the whole state machine:
 *   requested → approved → in_transit → received → completed
 *
 * Asserts: delta computed server-side (+₦1,500 for 1 × 2000→3500), approve
 * creates a REAL payment intent (idempotency key exchange_delta:<id>) with a
 * payment URL, double-decide is a CONFLICT, and every transition lands.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedExchangeOrder } from "./w43-exchange-seed";

export const journey: Journey = {
  id: "J327",
  name: "exchange positive delta → payment link, full lifecycle",
  feature: "exchange_requests state machine + payment intent reuse",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestExchange, decideExchange, transitionExchange, receiveExchange } =
      await import("../../server/services/exchanges");
    const phone = world.newPhone("j327");
    const seed = await seedExchangeOrder(world, "j327", phone);
    const notify = async () => {};

    // 1. Buyer requests a swap 1 × Origin (₦2,000) → Deluxe (₦3,500).
    const ex = await requestExchange(world.db, {
      tenantId: TENANT_ID, orderId: seed.orderId, fromOrderLineId: seed.orderLineId,
      toProductId: seed.toProductId, qty: 1, requestedBy: phone, requestedVia: "whatsapp", notify,
    });
    assert(ex.status === "requested", `requested (got ${ex.status})`);
    assert(ex.priceDeltaCents === 150_000, `delta +1500.00 NGN in kobo (got ${ex.priceDeltaCents})`);

    // 2. Merchant approves → REAL payment link (paystack via mocked fetch).
    const decided = await decideExchange(world.db, {
      exchangeId: ex.id, tenantId: TENANT_ID, approve: true, notify,
    });
    assert(decided.exchange.status === "approved", "approved");
    assert(decided.paymentUrl, "payment URL returned for positive delta");
    assert(decided.exchange.paymentIntentId, "paymentIntentId recorded");

    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.idempotencyKey, `exchange_delta:${ex.id}`)).limit(1);
    assert(intent, "payment_intents row exists with exchange idempotency key");
    assert(Math.round(Number(intent.amount) * 100) === 150_000, `intent amount 1500.00 (got ${intent.amount})`);
    assert(intent.orderId === seed.orderId && intent.tenantId === TENANT_ID, "intent tenant/order scoped");
    assert((intent.metadata as any)?.kind === "exchange_delta", "intent metadata kind");

    // Double decision is a CONFLICT — never a second link or a flip-flop.
    let dupThrew = false;
    try {
      await decideExchange(world.db, { exchangeId: ex.id, tenantId: TENANT_ID, approve: false, notify });
    } catch (e: any) { dupThrew = e?.code === "CONFLICT"; }
    assert(dupThrew, "double decide rejected with CONFLICT");
    const intents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.idempotencyKey, `exchange_delta:${ex.id}`));
    assert(intents.length === 1, "exactly one payment intent (no double charge)");

    // 3. approved → in_transit → received → completed.
    const transit = await transitionExchange(world.db, {
      exchangeId: ex.id, tenantId: TENANT_ID, to: "in_transit", notify,
    });
    assert(transit.status === "in_transit" && transit.inTransitAt, "in_transit stamped");

    const received = await receiveExchange(world.db, { exchangeId: ex.id, tenantId: TENANT_ID, notify });
    assert(received.status === "received" && received.receivedAt, "received stamped");

    const completed = await transitionExchange(world.db, {
      exchangeId: ex.id, tenantId: TENANT_ID, to: "completed", notify,
    });
    assert(completed.status === "completed" && completed.completedAt, "completed stamped");

    // 4. Notifications category registered for both channels.
    const parity = await import("../../server/services/channelParity");
    assert(parity.getParityCategory("exchange_status")?.telegram === "full", "exchange_status parity category registered");

    // Stock leg happened at receive: origin +1, replacement −1 (detailed
    // assertions are J330's job; here just the direction).
    const [fromP] = await world.db.select({ s: schema.products.stockQuantity }).from(schema.products)
      .where(and(eq(schema.products.id, seed.fromProductId), eq(schema.products.tenantId, TENANT_ID)));
    const [toP] = await world.db.select({ s: schema.products.stockQuantity }).from(schema.products)
      .where(and(eq(schema.products.id, seed.toProductId), eq(schema.products.tenantId, TENANT_ID)));
    assert(Number(fromP.s) === 21, `origin restocked 20→21 (got ${fromP.s})`);
    assert(Number(toP.s) === 9, `replacement reserved 10→9 (got ${toP.s})`);
  },
};
