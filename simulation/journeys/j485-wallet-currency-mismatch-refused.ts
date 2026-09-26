/**
 * J485 — escrow.createHold refuses a currency-mismatched wallet credit instead of silently corrupting
 * the balance (user: "everything should be naira").
 *
 * Found live 2026-09-26: `recordWalletTxInTx`'s "escrow_credit" branch (and the identical inline logic
 * paymentConfirm.ts used for the webhook-driven path) took `split.gross` — the ORDER's payment amount in
 * the ORDER's own currency — and added it straight into `merchantWallets.escrowBalance`, then labeled the
 * ledger row with `wallet.currency` regardless of whether they actually matched. This tenant has real
 * leftover non-NGN orders from the currency/location bug (see order-currency memory); had one of them
 * ever been paid, its USD amount would have silently become "₦" in the wallet with no numeric conversion
 * at all. Mirrors the SAME fail-closed design J374 already established for fxPayouts.execute (PAY-17) —
 * this was a gap in escrow-hold crediting specifically, not a new pattern.
 */
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, tenantCaller } from "./helpers";

const TID = "j485-currency-tenant";

export const journey: Journey = {
  id: "J485",
  name: "escrow.createHold refuses a currency-mismatched wallet credit",
  feature: "server/routers/escrow.ts recordWalletTxInTx currency guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();

    await world.db.insert(schema.tenants).values({
      id: TID, name: "J485 Currency Guard", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TID, userId: "4850", role: "owner",
    }).onConflictDoNothing();
    await approveKyb(world, TID);

    const [cfg] = await world.db.select().from(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1)).limit(1);
    const originalCustodyMode = cfg?.custodyMode ?? "pssp";
    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" }).where(eq(schema.escrowConfig.id, 1));
    try {
      // NGN wallet, matching this platform's real-world default.
      const walletId = crypto.randomUUID();
      await world.db.insert(schema.merchantWallets).values({
        id: walletId, tenantId: TID, currency: "NGN",
        availableBalance: "0.00", escrowBalance: "0.00",
        totalEarned: "0.00", totalWithdrawn: "0.00",
        custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
      }).onConflictDoNothing();

      // An order paid in USD — exactly this tenant's real historical shape.
      const orderId = crypto.randomUUID();
      await world.db.insert(schema.orders).values({
        id: orderId, tenantId: TID, customerId: "j485-customer",
        orderNumber: `ORD-J485-${Date.now()}`, status: "confirmed",
        totalAmount: "9500.00", currency: "USD", paymentStatus: "completed",
        createdAt: now, updatedAt: now,
      }).onConflictDoNothing();
      await world.db.insert(schema.paymentIntents).values({
        id: crypto.randomUUID(), tenantId: TID, orderId, customerId: "j485-customer",
        amount: "9500.00", currency: "USD", provider: "paystack", status: "completed",
        idempotencyKey: `j485-pi-${orderId}`, completedAt: now, createdAt: now, updatedAt: now,
      }).onConflictDoNothing();

      const caller = await tenantCaller(TID, { userId: 4850 });
      const hold = await caller.escrow.createHold({ orderId, tenantId: TID, currency: "USD" });

      assert(hold.currency === "USD", `escrow hold itself keeps the order's real currency (got ${hold.currency})`);
      assert(hold.buyerWalletTxId == null, "no wallet transaction was linked — the credit was refused, not silently mislabeled");

      const [wallet] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.id, walletId));
      assert(parseFloat(wallet.escrowBalance) === 0, `wallet escrowBalance untouched (got ${wallet.escrowBalance}) — a $9,500 credit must never silently become "₦9,500"`);

      const credits = await world.db.select().from(schema.walletTransactions)
        .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.orderId, orderId)));
      assert(credits.length === 0, "no wallet_transactions row was written for the mismatched-currency hold");
    } finally {
      await world.db.update(schema.escrowConfig).set({ custodyMode: originalCustodyMode as any }).where(eq(schema.escrowConfig.id, 1));
    }
  },
};
