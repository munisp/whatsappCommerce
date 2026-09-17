/**
 * === W41 (Coder B, UC-2) ===
 * J295 — Wallet spend at checkout: wallet-FIRST, partial allowed — a
 * ₦400 wallet against a ₦1,000 order applies ₦400 and leaves a ₦600 PSP
 * remainder; a retry returns the SAME application (never double-debits);
 * a wallet covering the full total leaves a ₦0 remainder.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J295",
  name: "checkout spend: wallet-first partial + idempotent retry",
  feature: "W41 UC-2 applyWalletAtCheckout seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const wallet = await import("../../server/services/customerWallet");
    const phone = world.newPhone("w41c");
    const credit = await wallet.creditWallet(TENANT_ID, phone, 40000, "merchant_goodwill", "goodwill:j295");
    assert(credit.ok === true, "seed wallet with ₦400");

    // Partial: ₦400 wallet vs ₦1,000 order → 40000 applied, 60000 PSP remainder.
    const orderId = `j295-${Date.now()}`;
    const app1 = await wallet.applyWalletAtCheckout(TENANT_ID, phone, orderId, 100000);
    assert(app1.appliedCents === 40000, `wallet-first applies full wallet: ${app1.appliedCents}`);
    assert(app1.remainderCents === 60000, `PSP remainder 60000, got ${app1.remainderCents}`);
    assert(app1.balanceCents === 0, "wallet drained");

    // Retry on the same order returns the SAME application (no double debit).
    const app2 = await wallet.applyWalletAtCheckout(TENANT_ID, phone, orderId, 100000);
    assert(app2.appliedCents === 40000 && app2.remainderCents === 60000, "idempotent per-order application");

    // Ledger shows the checkout spend referencing the order.
    const entries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.customerPhone, phone));
    const spend = entries.filter((e) => e.direction === "debit");
    assert(spend.length === 1, `exactly one debit, got ${spend.length}`);
    assert(spend[0].reason === "checkout_spend" && spend[0].refId === `checkout:${orderId}`, "debit references the order");
    assert(spend[0].balanceAfterCents === 0, "running balance lands on zero, never below");

    // Full coverage: a fat wallet leaves a ₦0 remainder (no PSP needed).
    await wallet.creditWallet(TENANT_ID, phone, 200000, "merchant_goodwill", "goodwill:j295b");
    const orderId2 = `j295b-${Date.now()}`;
    const app3 = await wallet.applyWalletAtCheckout(TENANT_ID, phone, orderId2, 100000);
    assert(app3.appliedCents === 100000 && app3.remainderCents === 0, "full wallet coverage, ₦0 remainder");
    assert(app3.balanceCents === 100000, "only the order total was spent");

    // Empty wallet: nothing applied, full remainder to PSP.
    const phone2 = world.newPhone("w41d");
    const app4 = await wallet.applyWalletAtCheckout(TENANT_ID, phone2, `j295c-${Date.now()}`, 50000);
    assert(app4.appliedCents === 0 && app4.remainderCents === 50000, "no wallet → full PSP remainder");
  },
};
