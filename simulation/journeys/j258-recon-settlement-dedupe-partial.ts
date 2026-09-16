/**
 * J258 — W38: settlement-reference dedupe + ±₦100 tolerance honesty in the
 * settlement recon auto-match (reconMatch).
 *
 *  1. UNDERPAYMENT within the ±₦100 tolerance → the settlement is NOT
 *     auto-confirmed as full settlement: the order is flagged with an
 *     explicit partial-settlement state, paymentStatus stays unpaid, and
 *     the tenant admin is alerted on WhatsApp.
 *  2. DUPLICATE settlement reference → claim-first dedupe
 *     (reconsettle:<tenant>:<ref>) rejects the replay; the order is never
 *     touched twice.
 *  3. The partial flag persists for manual review (receiptReview stays
 *     set) — money ambiguity fails CLOSED.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const T = "sim-pot-258";
const ADMIN_PHONE = "2349025800258";

export const journey: Journey = {
  id: "J258",
  name: "recon: duplicate settlement reference rejected; underpayment → partial + alert",
  feature: "W38 settlement reconciliation honesty",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { matchSettlement } = await import("../../server/services/reconMatch");

    await world.db.insert(schema.tenants).values({
      id: T, name: "Recon 258", slug: T, status: "active",
      whatsappPhoneNumberId: `pn_${T}`,
      settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: ADMIN_PHONE },
    }).onConflictDoNothing();

    // Flagged-review order: ₦6,300 total, receipt under manual review.
    await world.db.insert(schema.orders).values({
      id: "ord-258-1", tenantId: T, customerId: "2348011100258",
      orderNumber: "ORD-258-1", status: "pending",
      totalAmount: "6300.00", currency: "NGN", paymentStatus: "unpaid",
      metadata: { receiptReview: true },
    }).onConflictDoNothing();

    // 1. Underpayment by ₦50 (within the old ±₦100 auto-confirm window).
    const short = await matchSettlement(world.db, {
      tenantId: T, amount: 6250, reference: "SETL-258-SHORT",
    });
    assert(short.outcome === "partial" && short.orderId === "ord-258-1",
      `underpayment → partial, not confirmed (got ${JSON.stringify(short)})`);

    const [orderMid] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, "ord-258-1")).limit(1);
    assert(orderMid.paymentStatus !== "completed", "underpayment NEVER auto-confirms the order");
    const midMeta = orderMid.metadata as any;
    assert(midMeta?.receiptReview === true, "review flag kept for manual resolution");
    assert(midMeta?.reconPartialSettlement?.state === "partial", "explicit partial-settlement state");
    assert(midMeta?.reconPartialSettlement?.settledAmount === 6250 &&
      midMeta?.reconPartialSettlement?.expectedAmount === 6300,
      "partial flag carries both amounts");

    // Admin alerted on WhatsApp about the shortfall.
    const alerts = world.outbound.findByBody("PARTIAL settlement", ADMIN_PHONE);
    assert(alerts.length >= 1, "admin alerted about the partial settlement");
    assert(JSON.stringify(alerts[0].body).includes("NOT confirmed"), "alert is honest about non-confirmation");

    // 2. Replay the SAME settlement reference → rejected as duplicate.
    const replay = await matchSettlement(world.db, {
      tenantId: T, amount: 6250, reference: "SETL-258-SHORT",
    });
    assert(replay.outcome === "duplicate", `duplicate settlement reference rejected (got ${replay.outcome})`);

    // The replay did not touch the order again (flag written exactly once).
    const [orderAfter] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, "ord-258-1")).limit(1);
    const afterMeta = orderAfter.metadata as any;
    assert(afterMeta?.reconPartialSettlement?.flaggedAt === midMeta?.reconPartialSettlement?.flaggedAt,
      "duplicate replay never re-touches the order");

    // A DIFFERENT reference is still evaluated on its own merits (another
    // underpayment against the same still-flagged order → partial again,
    // proving dedupe is per-reference, not a blanket block).
    const second = await matchSettlement(world.db, {
      tenantId: T, amount: 6249, reference: "SETL-258-SECOND",
    });
    assert(second.outcome === "partial", "distinct reference still processed (partial)");
  },
};
