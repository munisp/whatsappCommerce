/**
 * === W32 earlypay-fx (Coder C) ===
 * J203 — wholesale early-payment discount:
 *  1. Supplier configures PO terms (2% for paying within 10 days, due +30d)
 *     → buyer sees a server-derived "Pay by <date> to save ₦Y" preview.
 *  2. Buyer pays early → wallet debited the DISCOUNTED amount (integer
 *     cents), supplier credited the same discounted amount honestly (their
 *     configured terms), order → 'paid' with discountApplied + discountCents.
 *  3. Double-early-pay → CONFLICT (claim-first guard; exactly one discount).
 *  4. After the window → discount honestly unavailable (preview saveCents 0,
 *     earlyPay refused) and NOTHING moves on the late path.
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, expectTrpcError } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const SUP = "sim-early-sup-203";
const BUY = "sim-early-buy-203";
const BUYER_BALANCE_CENTS = 5_000_000; // ₦50,000.00
const TOTAL_CENTS = 2_400_000; // 600 × ₦40.00
const SAVE_CENTS = Math.round((TOTAL_CENTS * 200) / 10_000); // 2% = ₦480.00

async function seedTenant(world: World, tid: string, name: string, balanceCents: number | null) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  await world.db.insert(schema.tenants).values({ id: tid, name, slug: tid, status: "active", createdAt: now, updatedAt: now }).onConflictDoNothing();
  const [u] = await world.db.insert(schema.users).values({ openId: `sim-${tid}-owner`, name: `${name} Owner`, tenantId: tid, lastSignedIn: now })
    .onConflictDoNothing().returning({ id: schema.users.id });
  const uid = u?.id ?? 203001;
  await world.db.insert(schema.tenantMemberships).values({ tenantId: tid, userId: String(uid), role: "owner" }).onConflictDoNothing();
  if (balanceCents != null) {
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: tid, currency: "NGN",
      availableBalance: fmtMajor(balanceCents), escrowBalance: "0.00",
      totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
  }
  return uid;
}

async function walletCents(world: World, tid: string): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tid));
  return w ? Math.round(parseFloat(w.availableBalance) * 100) : 0;
}

async function placeOrder(world: World): Promise<string> {
  const { createWholesaleListingTx, replaceWholesaleTiersTx, placeWholesaleOrderTx } =
    await import("../../server/services/wholesaleCatalog");
  const listing = await createWholesaleListingTx(world.db, {
    tenantId: SUP, title: "J203 Bulk Flour 50kg", category: "food", moq: 10, status: "active",
  });
  await replaceWholesaleTiersTx(world.db, {
    tenantId: SUP, listingId: listing.id,
    tiers: [{ minQty: 10, maxQty: 499, unitPriceCents: 4_500 }, { minQty: 500, maxQty: null, unitPriceCents: 4_000 }],
  });
  const r = await placeWholesaleOrderTx(world.db, { listingId: listing.id, quantity: 600, buyerTenantId: BUY, paymentMode: "pay_now" });
  assert(r.ok, `order placed (${JSON.stringify(r).slice(0, 200)})`);
  assert(r.order.totalCents === TOTAL_CENTS, `order total ${TOTAL_CENTS} (got ${r.order.totalCents})`);
  return r.order.id;
}

export const journey: Journey = {
  id: "J203",
  name: "early pay within window → discounted debit; double-tap CONFLICT; after window unavailable",
  feature: "W32 early-payment discounts: claim-first guarded discount + honest supplier credit",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const supUid = await seedTenant(world, SUP, "J203 Supplier", null);
    const buyUid = await seedTenant(world, BUY, "J203 Buyer", BUYER_BALANCE_CENTS);
    const supCaller = await tenantCaller(SUP, { userId: supUid });
    const buyCaller = await tenantCaller(BUY, { userId: buyUid });

    // ── 1. Supplier terms → buyer-facing server-derived preview ──────────
    const orderId = await placeOrder(world);
    await supCaller.wholesale.setPaymentTerms({
      tenantId: SUP, orderId, discountBps: 200, discountWindowDays: 10,
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    });
    const preview = await buyCaller.wholesale.earlyPayPreview({ tenantId: BUY, orderId });
    assert(preview.available === true, "preview shows discount available in window");
    assert(preview.saveCents === SAVE_CENTS, `preview saveCents ${SAVE_CENTS} (got ${preview.saveCents})`);
    assert(preview.payableCents === TOTAL_CENTS - SAVE_CENTS, "preview payableCents discounted");
    assert(preview.deadline != null, "preview deadline present");
    assertIncludes(preview.message, "Pay by", "buyer-facing 'Pay by X' copy");
    assertIncludes(preview.message, "480.00", "save amount in copy");

    // ── 2. Early pay: discounted debit + honest supplier credit ──────────
    const supBefore = await walletCents(world, SUP);
    const r = await buyCaller.wholesale.earlyPay({ tenantId: BUY, orderId });
    assert(r.ok === true, "early pay succeeds");
    assert(r.chargedCents === TOTAL_CENTS - SAVE_CENTS, `charged discounted ${TOTAL_CENTS - SAVE_CENTS} (got ${r.chargedCents})`);
    assert(r.saveCents === SAVE_CENTS, "saveCents recorded");
    assert(r.supplierCreditedCents === TOTAL_CENTS - SAVE_CENTS, "supplier credited the discounted amount");

    const buyAfter = await walletCents(world, BUY);
    assert(buyAfter === BUYER_BALANCE_CENTS - (TOTAL_CENTS - SAVE_CENTS), `buyer debited discounted amount (got ${buyAfter})`);
    const supAfter = await walletCents(world, SUP);
    assert(supAfter === supBefore + (TOTAL_CENTS - SAVE_CENTS), `supplier credited discounted amount (got ${supAfter})`);

    const [order] = await world.db.select().from(schema.wholesaleOrders).where(eq(schema.wholesaleOrders.id, orderId));
    assert(order.status === "paid", `order paid (got ${order.status})`);
    assert(order.discountApplied === true && order.discountCents === SAVE_CENTS, "discount recorded on the order");

    // Both ledger legs exist with deterministic references.
    const legs = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, `earlypay:${orderId}`));
    assert(legs.length === 1, "exactly one buyer debit leg");
    const supLegs = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, `earlypay:${orderId}:supplier`));
    assert(supLegs.length === 1, "exactly one supplier credit leg");

    // ── 3. Double-tap → CONFLICT, nothing moves again ────────────────────
    await expectTrpcError(buyCaller.wholesale.earlyPay({ tenantId: BUY, orderId }), "CONFLICT", "double early pay");
    assert((await walletCents(world, BUY)) === buyAfter, "double-tap moved nothing");

    // ── 4. After the window: discount honestly unavailable ───────────────
    const lateOrderId = await placeOrder(world);
    await supCaller.wholesale.setPaymentTerms({
      tenantId: SUP, orderId: lateOrderId, discountBps: 200, discountWindowDays: 10,
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    });
    // Sim time control: push the deadline into the past.
    await world.db.update(schema.wholesaleOrders)
      .set({ earlyPayDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.wholesaleOrders.id, lateOrderId));
    const latePreview = await buyCaller.wholesale.earlyPayPreview({ tenantId: BUY, orderId: lateOrderId });
    assert(latePreview.available === false && latePreview.saveCents === 0, "after window: preview honestly shows no discount");
    assert(latePreview.payableCents === TOTAL_CENTS, "after window: full amount payable");
    assertIncludes(latePreview.message, "expired", "honest expiry copy");
    const buyBalBeforeLate = await walletCents(world, BUY);
    await expectTrpcError(buyCaller.wholesale.earlyPay({ tenantId: BUY, orderId: lateOrderId }), "BAD_REQUEST", "late early pay refused");
    assert((await walletCents(world, BUY)) === buyBalBeforeLate, "late path moved nothing");
    const [lateOrder] = await world.db.select().from(schema.wholesaleOrders).where(eq(schema.wholesaleOrders.id, lateOrderId));
    assert(lateOrder.status === "pending" && lateOrder.discountApplied === false, "late order unchanged (normal full-payment path intact)");
  },
};
