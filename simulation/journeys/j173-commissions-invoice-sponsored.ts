/**
 * J173 — W30 (V3#12, V1#15, V2#16): commissions, invoice rate, sponsored spend.
 *   1. Marketplace commission is DERIVED server-side (order total + seller's
 *      admin-set rate) — caller supplies no amounts; one row per order
 *      (replay idempotent); settle is a guarded single flip.
 *   2. Invoice profit_share uses the PLATFORM-SET rate (escrow_config),
 *      revenue grouped by currency; mixed-currency periods are rejected.
 *   3. Sponsored placements debit spentTodayCents per serve with honest
 *      billing rows; the daily cap trips and stays tripped.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import crypto from "node:crypto";
import {
  adminCaller, createChatOrderViaNlp, expectTrpcError,
  publicCaller, tenantCaller,
} from "./helpers";

export const journey: Journey = {
  id: "J173",
  name: "server-derived commissions + invoice config rate + sponsored spend cap",
  feature: "V3#12 + V1#15 + V2#16 remediation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const tenant = await tenantCaller(TENANT_ID, { userId: 1731 });
    const pub = await publicCaller();
    const phone = world.newPhone("cm");
    await world.grantConsent(phone);

    // ── 1. Server-derived commission ─────────────────────────────────────
    const { id: sellerId } = await pub.marketplace.registerSeller({
      tenantId: TENANT_ID, businessName: "J173 Seller", ownerPhone: phone,
    });
    await admin.marketplace.updateSellerStatus({ id: sellerId, status: "active" });
    await admin.marketplace.updateSellerCommission({ id: sellerId, commissionRate: "12.50" });

    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const orderCents = Math.round(order.total * 100); // 250,000
    const rec = await tenant.marketplace.recordCommission({ tenantId: TENANT_ID, sellerId, orderId: order.orderId });
    const [comm] = await world.db.select().from(schema.marketplaceCommissions)
      .where(eq(schema.marketplaceCommissions.id, rec.id));
    assert(comm, "commission recorded");
    assert(Number(comm.saleAmount) === orderCents / 100, `sale derived from the order (got ${comm.saleAmount})`);
    assert(Number(comm.commissionRate) === 12.5, `rate from seller config (got ${comm.commissionRate})`);
    // 250,000 × 12.5% = 31,250 cents = 312.50
    assert(Number(comm.commissionAmount) === 312.5, `commission derived server-side (got ${comm.commissionAmount})`);
    const replay = await tenant.marketplace.recordCommission({ tenantId: TENANT_ID, sellerId, orderId: order.orderId });
    assert(replay.alreadyRecorded === true, "one commission per order (replay idempotent)");
    await tenant.marketplace.settleCommission({ id: rec.id });
    await expectTrpcError(
      tenant.marketplace.settleCommission({ id: rec.id }),
      "CONFLICT", "double settle blocked",
    );

    // ── 2. Invoice: platform-set rate + currency grouping ────────────────
    // Seed a completed NGN order (same pattern as j155) plus a USD one —
    // a mixed-currency period must be honestly rejected.
    const paidNgnId = crypto.randomUUID();
    await world.db.insert(schema.orders).values({
      id: paidNgnId, tenantId: TENANT_ID, customerId: "sim-customer-j173",
      orderNumber: `J173-${crypto.randomUUID().slice(0, 8)}`, status: "delivered",
      totalAmount: "10000.00", currency: "NGN", paymentStatus: "completed",
    });
    const paidUsdId = crypto.randomUUID();
    await world.db.insert(schema.orders).values({
      id: paidUsdId, tenantId: TENANT_ID, customerId: "sim-customer-j173",
      orderNumber: `J173U-${crypto.randomUUID().slice(0, 8)}`, status: "delivered",
      totalAmount: "500.00", currency: "USD", paymentStatus: "completed",
    });
    const periodStart = new Date(Date.now() - 24 * 3600_000).toISOString();
    const periodEnd = new Date(Date.now() + 24 * 3600_000).toISOString();
    await expectTrpcError(
      tenant.invoice.generate({ tenantId: TENANT_ID, type: "profit_share", periodStart, periodEnd }),
      "PRECONDITION_FAILED", "mixed-currency invoicing rejected",
    );
    await world.db.delete(schema.orders).where(eq(schema.orders.id, paidUsdId));
    const invoice = await tenant.invoice.generate({ tenantId: TENANT_ID, type: "profit_share", periodStart, periodEnd });
    assert(invoice.currency === "NGN", `invoice currency from revenue (got ${invoice.currency})`);
    // Rate comes from escrow_config.platform_fee_rate (admin-set) — read it
    // back and assert the invoice used exactly that, never a client value.
    const [cfg] = await world.db.select().from(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1));
    const configRate = Number(cfg?.platformFeeRate ?? "0.03125");
    assert(invoice.commissionRate === configRate.toFixed(4),
      `platform-set rate ${configRate.toFixed(4)}, not client (got ${invoice.commissionRate})`);
    const rev = Number(invoice.subtotal);
    const expectedCommission = Math.round(Math.round(rev * 100) * configRate) / 100;
    assert(Math.abs(Number(invoice.commissionAmount) - expectedCommission) < 0.005,
      `commission = platform rate × revenue (got ${invoice.commissionAmount}, want ${expectedCommission})`);

    // ── 3. Sponsored spend writer + cap ──────────────────────────────────
    const lat = 6.5244, lng = 3.3792;
    await tenant.geo.merchant.setLocation({ latitude: lat, longitude: lng, label: "J173 shop" });
    await tenant.geo.merchant.setDiscoverable({ discoverable: true });
    const listing = await tenant.geo.merchant.createSponsoredListing({
      name: "J173 placement", centerLat: lat, centerLng: lng, radiusKm: 5,
      bidCents: 5_000, dailyBudgetCents: 10_000,
    });
    const spendEvents = async () =>
      world.db.select().from(schema.sponsoredSpendEvents).where(eq(schema.sponsoredSpendEvents.listingId, listing.id));
    const spentNow = async () => {
      const [row] = await world.db.select().from(schema.sponsoredListings).where(eq(schema.sponsoredListings.id, listing.id));
      return Number(row.spentTodayCents);
    };

    for (let i = 1; i <= 3; i++) {
      const res = await pub.geo.discover({ lat, lng, radiusKm: 5 });
      const mine = res.items.find((it: any) => it.tenantId === TENANT_ID);
      const spent = await spentNow();
      if (i <= 2) {
        assert(mine?.sponsored === true, `serve ${i}: placement served as sponsored`);
        assert(spent === i * 5_000, `serve ${i}: debited ${i * 5_000} (got ${spent})`);
      } else {
        assert(spent === 10_000, `cap holds at budget (got ${spent})`);
        assert(mine == null || mine.sponsored !== true, "serve 3: over-budget placement no longer boosted");
      }
    }
    const events = await spendEvents();
    assert(events.length === 2, `honest billing rows: exactly 2 debits (got ${events.length})`);
    assert(events.every((e: any) => e.amountCents === 5_000 && e.kind === "serve"), "billing rows carry the real debit");

    // Daily reset sweep: after rollover the counter zeroes deterministically.
    const geo = await import("../../server/services/geoDiscovery");
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await world.db.update(schema.sponsoredListings)
      .set({ spentOnDate: yesterday.toISOString().slice(0, 10) })
      .where(eq(schema.sponsoredListings.id, listing.id));
    const reset = await geo.resetSponsoredSpendDaily(world.db);
    assert(reset >= 1, "stale counters reset");
    assert((await spentNow()) === 0, "counter reset after date rollover");
  },
};
