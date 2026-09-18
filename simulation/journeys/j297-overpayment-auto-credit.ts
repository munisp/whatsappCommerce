/**
 * === W41 (Coder B, UC-2) ===
 * J297 — Overpayment auto-credit: when a charge settles ABOVE the order
 * total, the excess becomes store credit (adjacent seam in the PAY
 * overpayment handling — paymentConfirm.ts untouched), idempotent on the
 * payment reference, and spendable at the next checkout.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J297",
  name: "overpayment auto-credits the wallet, idempotent per reference",
  feature: "W41 UC-2 overpayment credit seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const wallet = await import("../../server/services/customerWallet");
    const phone = world.newPhone("w41f");
    const orderId = `j297-${Date.now()}`;
    const payRef = `payref-j297-${Date.now()}`;

    // Buyer overpaid ₦1,250 on the order → excess becomes store credit.
    const c1 = await wallet.creditOverpayment(TENANT_ID, phone, orderId, 125000, payRef);
    assert(c1.ok === true && c1.balanceCents === 125000, `overpayment credited: ${JSON.stringify(c1)}`);

    // Same payment reference retried (webhook redelivery) → no double credit.
    const c2 = await wallet.creditOverpayment(TENANT_ID, phone, orderId, 125000, payRef);
    assert(c2.ok === true && c2.duplicate === true, "redelivery is a duplicate");
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 125000, "no double credit");

    const entries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.customerPhone, phone));
    assert(entries.length === 1 && entries[0].reason === "overpayment", "ledger records the overpayment reason");
    assert(entries[0].refId === `overpay:${orderId}:${payRef}`, "deterministic idempotency reference");

    // The credit is spendable immediately at the next checkout.
    const app = await wallet.applyWalletAtCheckout(TENANT_ID, phone, `j297b-${Date.now()}`, 200000);
    assert(app.appliedCents === 125000 && app.remainderCents === 75000, "overpayment credit spends wallet-first");
  },
};
