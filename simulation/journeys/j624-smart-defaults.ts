// === W65 conversational ===
/**
 * J624 — R10 smart defaults engine:
 *   1. delivery_address: buyer's last-used shipping address wins (own > tenant).
 *   2. payout_account: the W59 primary merchant_payout_accounts row.
 *   3. price_band: catalogAI comparables median for a category.
 *   4. quantity: median order-line qty (order cadence) for a product.
 *   5. payment_terms: W56 grade band → net terms days.
 *   6. Correction capture: smartDefaults.correct inserts a ui_events row with
 *      action 'default_corrected' carrying suggested vs actual.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J624",
  name: "smartDefaults per-context predictions + correction learning event",
  feature: "W65 R10 smart defaults engine",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── Seeds ──────────────────────────────────────────────────────────────
    await world.db.insert(schema.orders).values({
      id: "o-j624-addr", tenantId: TENANT_ID, customerId: "c-j624", orderNumber: "SIM-J624-1",
      status: "delivered", totalAmount: "42.00", currency: "NGN", paymentStatus: "completed",
      shippingAddress: { street: "12 Marina Rd", city: "Lagos", note: "j624" },
    }).onConflictDoNothing();
    await world.db.insert(schema.orders).values([
      { id: "o-j624-q1", tenantId: TENANT_ID, customerId: "c-j624", orderNumber: "SIM-J624-2", status: "delivered", totalAmount: "10.00", currency: "NGN", paymentStatus: "completed" },
      { id: "o-j624-q2", tenantId: TENANT_ID, customerId: "c-j624", orderNumber: "SIM-J624-3", status: "delivered", totalAmount: "10.00", currency: "NGN", paymentStatus: "completed" },
      { id: "o-j624-q3", tenantId: TENANT_ID, customerId: "c-j624", orderNumber: "SIM-J624-4", status: "delivered", totalAmount: "10.00", currency: "NGN", paymentStatus: "completed" },
    ]).onConflictDoNothing();
    await world.db.insert(schema.products).values({
      id: "p-j624", tenantId: TENANT_ID, sku: "SIM-J624-P", name: "J624 Cadence Rice",
      price: "100.00", currency: "NGN", status: "active", stockQuantity: 50,
    }).onConflictDoNothing();
    await world.db.insert(schema.orderItems).values([
      { id: "oi-j624-1", orderId: "o-j624-q1", productId: "p-j624", productName: "J624 Cadence Rice", quantity: 2, unitPrice: "100.00", currency: "NGN" },
      { id: "oi-j624-2", orderId: "o-j624-q2", productId: "p-j624", productName: "J624 Cadence Rice", quantity: 4, unitPrice: "100.00", currency: "NGN" },
      { id: "oi-j624-3", orderId: "o-j624-q3", productId: "p-j624", productName: "J624 Cadence Rice", quantity: 2, unitPrice: "100.00", currency: "NGN" },
    ]).onConflictDoNothing();
    await world.db.insert(schema.products).values([
      { id: "p-j624-b1", tenantId: TENANT_ID, sku: "SIM-J624-B1", name: "Band A", price: "100.00", currency: "NGN", status: "active", category: "j624-cat", stockQuantity: 1 },
      { id: "p-j624-b2", tenantId: TENANT_ID, sku: "SIM-J624-B2", name: "Band B", price: "200.00", currency: "NGN", status: "active", category: "j624-cat", stockQuantity: 1 },
      { id: "p-j624-b3", tenantId: TENANT_ID, sku: "SIM-J624-B3", name: "Band C", price: "300.00", currency: "NGN", status: "active", category: "j624-cat", stockQuantity: 1 },
    ]).onConflictDoNothing();

    const [wallet] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TENANT_ID))
      .limit(1);
    const walletId = wallet?.id ?? "w-j624";
    if (!wallet) {
      await world.db.insert(schema.merchantWallets).values({ id: "w-j624", tenantId: TENANT_ID }).onConflictDoNothing();
    }
    await world.db.insert(schema.merchantPayoutAccounts).values({
      id: "00000000-0000-4000-8000-00000000j624".replace("j624", "0624"),
      tenantId: TENANT_ID,
      walletId,
      bankCode: "058",
      accountNumber: "0123456789",
      accountName: "J624 Primary",
      provider: "paystack",
      isPrimary: true,
      status: "active",
    }).onConflictDoNothing();

    await world.db.insert(schema.creditScores).values({
      tenantId: TENANT_ID,
      subjectType: "buyer",
      subjectId: "buyer-j624",
      score: 700,
      grade: "B",
      factors: { source: "j624" },
    }).onConflictDoNothing();

    const caller = await tenantCaller(TENANT_ID);

    // ── 1. delivery address ────────────────────────────────────────────────
    const addr: any = await caller.smartDefaults.forContext({
      tenantId: TENANT_ID, userId: "c-j624", context: "delivery_address",
    });
    assert(addr.value?.street === "12 Marina Rd", `last-used address (got ${JSON.stringify(addr.value)})`);
    assert(addr.confidence >= 0.5, "own address is high-confidence");

    // ── 2. payout account ──────────────────────────────────────────────────
    const payout: any = await caller.smartDefaults.forContext({ tenantId: TENANT_ID, context: "payout_account" });
    assert(payout.value?.accountNumber === "0123456789", `primary payout account (got ${JSON.stringify(payout.value)})`);

    // ── 3. price band ──────────────────────────────────────────────────────
    const band: any = await caller.smartDefaults.forContext({
      tenantId: TENANT_ID, context: "price_band", category: "j624-cat",
    });
    assert(Number(band.value?.suggestedPriceCents) === 20_000, `median comparable ₦200 (got ${JSON.stringify(band.value)})`);

    // ── 4. quantity cadence ────────────────────────────────────────────────
    const qty: any = await caller.smartDefaults.forContext({
      tenantId: TENANT_ID, context: "quantity", productId: "p-j624",
    });
    assert(Number(qty.value?.quantity) === 2, `median order qty 2 (got ${JSON.stringify(qty.value)})`);

    // ── 5. payment terms from W56 grade ────────────────────────────────────
    const terms: any = await caller.smartDefaults.forContext({
      tenantId: TENANT_ID, context: "payment_terms", subjectId: "buyer-j624",
    });
    assert(terms.value?.grade === "B" && terms.value?.termsDays === 21, `grade B → net 21 (got ${JSON.stringify(terms.value)})`);

    // ── 6. correction learning event ───────────────────────────────────────
    const corr: any = await caller.smartDefaults.correct({
      tenantId: TENANT_ID,
      app: "tenant-portal",
      context: "price_band",
      suggested: band.value,
      actual: { priceCents: 25_000 },
    });
    assert(corr.recorded === true, "correction recorded");
    const events = await world.db
      .select()
      .from(schema.uiEvents)
      .where(and(eq(schema.uiEvents.tenantId, TENANT_ID), eq(schema.uiEvents.action, "default_corrected")));
    assert(
      events.some((e: any) => (e.metadata as any)?.context === "price_band" && (e.metadata as any)?.actual?.priceCents === 25_000),
      "ui_events default_corrected row carries suggested vs actual",
    );
  },
};
