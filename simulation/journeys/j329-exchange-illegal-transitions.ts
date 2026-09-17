/**
 * === W43 exchanges (Coder B) ===
 * J329 — Exchange state machine enforcement: EVERY illegal transition is
 * rejected (CONFLICT/BAD_REQUEST) and no state or stock changes.
 *
 * Matrix asserted:
 *   requested → in_transit (skip approve)           CONFLICT
 *   requested → received via transitionExchange     BAD_REQUEST (stock leg)
 *   requested → received via receiveExchange        CONFLICT (guard)
 *   requested → completed                           CONFLICT
 *   rejected  → anything                            CONFLICT (terminal)
 *   in_transit → approved (backwards)               CONFLICT
 *   completed → anything                            CONFLICT (terminal)
 *   cancelled → anything                            CONFLICT (terminal)
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedExchangeOrder, stockOf } from "./w43-exchange-seed";

async function expectThrow(fn: () => Promise<unknown>, codes: string[], label: string) {
  let code: string | null = null;
  try { await fn(); } catch (e: any) { code = e?.code ?? "ERR"; }
  assert(code !== null && codes.includes(code), `${label} rejected with ${codes.join("/")} (got ${code ?? "no throw"})`);
}

export const journey: Journey = {
  id: "J329",
  name: "exchange state machine rejects illegal transitions",
  feature: "exchange_requests guarded transitions",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestExchange, decideExchange, transitionExchange, receiveExchange } =
      await import("../../server/services/exchanges");
    const phone = world.newPhone("j329");
    const seed = await seedExchangeOrder(world, "j329", phone);
    const notify = async () => {};
    const mk = () => requestExchange(world.db, {
      tenantId: TENANT_ID, orderId: seed.orderId, fromOrderLineId: seed.orderLineId,
      toProductId: seed.toProductId, qty: 1, requestedBy: phone, notify,
    });

    // 1. From 'requested': skip-approve transitions are illegal.
    const a = await mk();
    await expectThrow(() => transitionExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, to: "in_transit", notify }), ["CONFLICT"], "requested→in_transit");
    await expectThrow(() => transitionExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, to: "received", notify }), ["BAD_REQUEST"], "requested→received (transition)");
    await expectThrow(() => receiveExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, notify }), ["CONFLICT"], "requested→received (receive)");
    await expectThrow(() => transitionExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, to: "completed", notify }), ["CONFLICT"], "requested→completed");
    let [row] = await world.db.select().from(schema.exchangeRequests).where(eq(schema.exchangeRequests.id, a.id));
    assert(row.status === "requested", "still requested after illegal attempts");

    // 2. 'rejected' is terminal.
    const b = await mk();
    await decideExchange(world.db, { exchangeId: b.id, tenantId: TENANT_ID, approve: false, note: "no", notify });
    await expectThrow(() => transitionExchange(world.db, { exchangeId: b.id, tenantId: TENANT_ID, to: "in_transit", notify }), ["CONFLICT"], "rejected→in_transit");
    await expectThrow(() => decideExchange(world.db, { exchangeId: b.id, tenantId: TENANT_ID, approve: true, notify }), ["CONFLICT"], "rejected→approved re-decide");

    // 3. Backwards transition in_transit→approved is illegal.
    const c = await mk();
    await decideExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, approve: true, notify });
    await transitionExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, to: "in_transit", notify });
    await expectThrow(() => transitionExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, to: "approved", notify }), ["CONFLICT"], "in_transit→approved");
    await expectThrow(() => transitionExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, to: "completed", notify }), ["CONFLICT"], "in_transit→completed (skip receive)");

    // 4. 'completed' and 'cancelled' are terminal. Zero-delta swaps keep the
    //    money legs out of the way (equal-price products: origin→origin price
    //    tier via cheap→cheap is impossible; use qty 1 origin→origin-priced
    //    replacement is not seeded — so walk the REAL paths to the terminals).
    const stockToBefore = await stockOf(world, seed.toProductId);
    await receiveExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, notify });
    await transitionExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, to: "completed", notify });
    await expectThrow(() => transitionExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, to: "cancelled", notify }), ["CONFLICT"], "completed→cancelled");
    await expectThrow(() => receiveExchange(world.db, { exchangeId: c.id, tenantId: TENANT_ID, notify }), ["CONFLICT"], "completed→received replay");
    const stockToAfter = await stockOf(world, seed.toProductId);
    assert(stockToAfter === stockToBefore - 1, "exactly one reserve despite replay attempts");

    // 'requested' → cancelled is legal; 'cancelled' is then terminal.
    await transitionExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, to: "cancelled", notify });
    [row] = await world.db.select().from(schema.exchangeRequests).where(eq(schema.exchangeRequests.id, a.id));
    assert(row.status === "cancelled" && row.cancelledAt, "requested→cancelled legal");
    await expectThrow(() => transitionExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, to: "in_transit", notify }), ["CONFLICT"], "cancelled→in_transit");
    await expectThrow(() => decideExchange(world.db, { exchangeId: a.id, tenantId: TENANT_ID, approve: true, notify }), ["CONFLICT"], "cancelled→approved");

    // 5. Cross-tenant access is invisible (NOT_FOUND), never a leak.
    await expectThrow(
      () => transitionExchange(world.db, { exchangeId: c.id, tenantId: "other-tenant", to: "cancelled", notify }),
      ["NOT_FOUND"],
      "cross-tenant transition",
    );
  },
};
