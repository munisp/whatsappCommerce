/**
 * J146 — Wholesale marketplace: supplier publishes a tiered listing; a
 * WhatsApp buyer browses ("wholesale …"), gets the tier menu, orders via
 * "buy <#> <qty>" and is charged the CORRECT tier unit price (integer
 * cents); below-MOQ quantities are refused with guidance.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, SUPPLIER_TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J146",
  name: "wholesale browse → tiered order",
  feature: "wholesaleCatalog tiered pricing + WhatsApp browse/buy",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createWholesaleListingTx, replaceWholesaleTiersTx, computeTieredPrice } =
      await import("../../server/services/wholesaleCatalog");

    // ── 1. Supplier publishes a tiered listing (integer cents) ──────────
    const listing = await createWholesaleListingTx(world.db, {
      tenantId: SUPPLIER_TENANT_ID,
      title: "PET Preforms 500ml (bulk)",
      category: "packaging",
      moq: 100,
      status: "active",
    });
    await replaceWholesaleTiersTx(world.db, {
      tenantId: SUPPLIER_TENANT_ID,
      listingId: listing.id,
      tiers: [
        { minQty: 100, maxQty: 499, unitPriceCents: 4_500 },   // ₦45.00
        { minQty: 500, maxQty: null, unitPriceCents: 4_000 },  // ₦40.00
      ],
    });

    // Pure pricing check mirrors the DB path.
    const q = computeTieredPrice(
      [
        { minQty: 100, maxQty: 499, unitPriceCents: 4_500 },
        { minQty: 500, maxQty: null, unitPriceCents: 4_000 },
      ],
      600,
      100,
    );
    assert(q.ok && q.unitPriceCents === 4_000 && q.totalCents === 2_400_000, "tier resolution @600 units");

    // ── 2. WhatsApp buyer browses the marketplace ────────────────────────
    const phone = world.newPhone("ws");
    await world.grantConsent(phone);
    await world.text(phone, "wholesale preforms");
    const browseReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(browseReply, "Wholesale marketplace", "browse header");
    assertIncludes(browseReply, "PET Preforms 500ml (bulk)", "listing shown");
    assertIncludes(browseReply, "MOQ 100", "MOQ shown");
    assertIncludes(browseReply, "NGN 45.00/unit", "first tier price shown");

    // ── 3. Below-MOQ order is refused with guidance ──────────────────────
    await world.text(phone, "buy 1 50");
    const moqReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(moqReply, "minimum order quantity", "MOQ refusal guidance");

    // ── 4. Valid order lands on the CORRECT tier (600 units → ₦40.00) ────
    await world.text(phone, "buy 1 600");
    const orderReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderReply, "Wholesale order placed", "order confirmation");
    assertIncludes(orderReply, "NGN 24,000.00", "tiered total (600 × ₦40.00)");

    const [order] = await world.db
      .select()
      .from(schema.wholesaleOrders)
      .where(eq(schema.wholesaleOrders.listingId, listing.id))
      .limit(1);
    assert(order, "wholesale_orders row persisted");
    assert(order.tenantId === SUPPLIER_TENANT_ID, "supplier tenant owns the order");
    assert(order.buyerPhone?.replace(/\D/g, "") === phone.replace(/\D/g, ""), "buyer phone recorded");
    assert(order.quantity === 600, `quantity (got ${order.quantity})`);
    assert(order.unitPriceCents === 4_000, `tier unit price (got ${order.unitPriceCents})`);
    assert(order.totalCents === 2_400_000, `integer-cents total (got ${order.totalCents})`);
    assert(order.paymentMode === "pay_now" && order.status === "pending", "pay-now order pending");

    // ── 5. Cross-tenant visibility: supplier sees the sale; the retail
    // sim tenant (TENANT_ID) does NOT see it in its own order book. ───────
    const { listWholesaleOrdersTx } = await import("../../server/services/wholesaleCatalog");
    const supplierBook = await listWholesaleOrdersTx(world.db, { tenantId: SUPPLIER_TENANT_ID, role: "supplier" });
    assert(supplierBook.some((o) => o.id === order.id), "supplier order book includes the sale");
    const otherBook = await listWholesaleOrdersTx(world.db, { tenantId: TENANT_ID, role: "supplier" });
    assert(!otherBook.some((o) => o.id === order.id), "tenant isolation on the order book");
  },
};
