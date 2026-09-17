/**
 * === W41 rma-fx (Coder C) ===
 * J304 — Refund-to-wallet: the RMA refund leg credits the customer's wallet
 * via the Coder B seam (injected here), the wallet credit COUNTS TOWARD the
 * cumulative refunded total on the escrow, and a further refund beyond the
 * remaining balance is refused (cap parity with the PSP path).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedRmaOrder } from "./w41-rma-seed";

export const journey: Journey = {
  id: "J304",
  name: "RMA refund-to-wallet seam + cumulative cap",
  feature: "creditWallet contract seam; wallet credit counts toward refunded total",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestReturn, decideReturn, receiveAndRestock, refundReturn } = await import("../../server/services/rma");
    const phone = world.newPhone("j304");
    const seed = await seedRmaOrder(world, "j304", phone);
    const notify = { waSend: async () => {}, tgSend: async () => {} };

    // === W41 merger === the REAL Coder B wallet (no stub): the RMA wallet
    // refund must land in customer_wallets with the append-only ledger row.
    const wallet = await import("../../server/services/customerWallet");

    const { rma } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed.orderId, reason: "wrong size", ...notify,
    });
    await decideReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, approve: true, ...notify });
    await receiveAndRestock(world.db, { rmaId: rma.id, tenantId: TENANT_ID, ...notify });

    const res = await refundReturn(world.db, {
      rmaId: rma.id, tenantId: TENANT_ID, method: "wallet", ...notify,
    });
    assert(res.method === "wallet" && res.refundedCents === seed.totalCents, "wallet refund recorded");
    // Real wallet: balance + append-only ledger entry with idempotency ref.
    assert((await wallet.walletBalance(TENANT_ID, phone)) === seed.totalCents,
      `real wallet holds the RMA refund, got ${await wallet.walletBalance(TENANT_ID, phone)}`);
    const walletEntries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.customerPhone, phone));
    assert(walletEntries.length === 1, "wallet ledger credited exactly once");
    assert(walletEntries[0].reason === "refund_to_wallet" && walletEntries[0].refId === `rma_refund:${rma.id}`,
      "ledger entry carries shared reason + namespaced idempotency ref");
    assert(walletEntries[0].amountCents === seed.totalCents, "integer kobo amount");

    // Wallet credit counts toward the cumulative refunded total.
    const [escrow] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, seed.escrowId));
    assert(Number((escrow.metadata as any)?.refundedAmount) === 5000,
      `escrow refundedAmount includes wallet credit (got ${(escrow.metadata as any)?.refundedAmount})`);

    const [row] = await world.db.select().from(schema.rmaRequests).where(eq(schema.rmaRequests.id, rma.id));
    assert(row.status === "refunded" && row.refundMethod === "wallet" && row.refundedCents === seed.totalCents,
      "RMA terminal refunded/wallet");

    // A wallet credit beyond the refundable balance is refused (second order).
    const seed2 = await seedRmaOrder(world, "j304b", phone);
    const { rma: rma2 } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed2.orderId, reason: "damaged", ...notify,
    });
    await decideReturn(world.db, { rmaId: rma2.id, tenantId: TENANT_ID, approve: true, ...notify });
    await receiveAndRestock(world.db, { rmaId: rma2.id, tenantId: TENANT_ID, ...notify });
    let overThrew = false;
    try {
      await refundReturn(world.db, {
        rmaId: rma2.id, tenantId: TENANT_ID, method: "wallet", amountCents: 600_000, ...notify,
      });
    } catch (e: any) { overThrew = e?.code === "CONFLICT"; }
    assert(overThrew, "wallet credit beyond cap refused");
    assert((await wallet.walletBalance(TENANT_ID, phone)) === seed.totalCents, "no wallet write for the refused credit");

    // Wallet seam failure surfaces honestly (no silent refund loss).
    const seed3 = await seedRmaOrder(world, "j304c", phone);
    const { rma: rma3 } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed3.orderId, reason: "late delivery", ...notify,
    });
    await decideReturn(world.db, { rmaId: rma3.id, tenantId: TENANT_ID, approve: true, ...notify });
    await receiveAndRestock(world.db, { rmaId: rma3.id, tenantId: TENANT_ID, ...notify });
    let failThrew = false;
    try {
      await refundReturn(world.db, {
        rmaId: rma3.id, tenantId: TENANT_ID, method: "wallet", ...notify,
        creditWalletImpl: async () => ({ credited: false, reason: "wallet_unavailable_stub" }),
      });
    } catch (e: any) { failThrew = e?.code === "PRECONDITION_FAILED"; }
    assert(failThrew, "wallet seam failure surfaces as PRECONDITION_FAILED");
  },
};
