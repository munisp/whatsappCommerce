/**
 * === W41 rma-fx (Coder C) ===
 * J303 — RMA refunds respect the W38 cumulative caps: a refund above the
 * remaining escrow balance is refused, partial refunds accumulate, and a
 * second full refund on an already-refunded RMA is a CONFLICT (idempotent —
 * no double money movement).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedRmaOrder } from "./w41-rma-seed";

export const journey: Journey = {
  id: "J303",
  name: "RMA refund caps + idempotency",
  feature: "refundEscrowAtomic cumulative cap respected from RMA path",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestReturn, decideReturn, receiveAndRestock, refundReturn } = await import("../../server/services/rma");
    const phone = world.newPhone("j303");
    const seed = await seedRmaOrder(world, "j303", phone);
    const notify = { waSend: async () => {}, tgSend: async () => {} };

    const { rma } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed.orderId, reason: "damaged", ...notify,
    });
    await decideReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, approve: true, ...notify });
    await receiveAndRestock(world.db, { rmaId: rma.id, tenantId: TENANT_ID, ...notify });

    // Over-refund (₦6,000 > ₦5,000 escrow) refused by the W38 cap.
    let overThrew = false;
    try {
      await refundReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, method: "psp", amountCents: 600_000, ...notify });
    } catch (e: any) { overThrew = e?.code === "CONFLICT"; }
    assert(overThrew, "over-refund refused");

    // RMA unchanged by the refused refund.
    let [row] = await world.db.select().from(schema.rmaRequests).where(eq(schema.rmaRequests.id, rma.id));
    assert(row.status === "restocked", `still restocked (got ${row.status})`);

    // Partial refund accumulates against the cap.
    const part = await refundReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, method: "psp", amountCents: 200_000, ...notify });
    assert(part.refundedCents === 200_000, "partial refund recorded");
    let [escrow] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, seed.escrowId));
    assert(Number((escrow.metadata as any)?.refundedAmount) === 2000, "escrow refundedAmount accumulates");
    assert(escrow.state === "escrow_held", "partial refund keeps escrow state");

    // RMA is refunded now; a second refund is idempotent-refused.
    let againThrew = false;
    try {
      await refundReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, method: "psp", amountCents: 100_000, ...notify });
    } catch (e: any) { againThrew = e?.code === "CONFLICT"; }
    assert(againThrew, "second refund refused (already refunded)");
    [escrow] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, seed.escrowId));
    assert(Number((escrow.metadata as any)?.refundedAmount) === 2000, "no double money movement");
    [row] = await world.db.select().from(schema.rmaRequests).where(eq(schema.rmaRequests.id, rma.id));
    assert(row.status === "refunded" && row.refundedCents === 200_000, "RMA terminal with partial amount");
  },
};
