/**
 * === W43 exchanges (Coder B) ===
 * J330 — Exchange 'received' stock legs, in ONE transaction, audited:
 *   a) clean return: fromLine restocked (products + inventory_snapshots),
 *      audit 'exchange_in' +qty; toLine claim-first reserve (conditional
 *      decrement + inventory_reservations row), audit 'exchange_out' −qty.
 *   b) damaged return: NO restock (write-off), 0-delta 'damage' audit row;
 *      the replacement reserve still happens.
 *   c) insufficient replacement stock: receive throws PRECONDITION_FAILED,
 *      the WHOLE receipt rolls back — exchange stays in_transit and the
 *      origin product is NOT restocked.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedExchangeOrder, stockOf } from "./w43-exchange-seed";

export const journey: Journey = {
  id: "J330",
  name: "exchange receive: restock-or-writeoff + claim-first reserve + audit",
  feature: "exchange stock legs with stock_adjustments audit",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestExchange, decideExchange, transitionExchange, receiveExchange } =
      await import("../../server/services/exchanges");
    const phone = world.newPhone("j330");
    const seed = await seedExchangeOrder(world, "j330", phone);
    const notify = async () => {};
    const open = async (toProductId: string, damaged = false) => {
      const ex = await requestExchange(world.db, {
        tenantId: TENANT_ID, orderId: seed.orderId, fromOrderLineId: seed.orderLineId,
        toProductId, qty: 1, requestedBy: phone, damaged, notify,
      });
      await decideExchange(world.db, { exchangeId: ex.id, tenantId: TENANT_ID, approve: true, notify });
      await transitionExchange(world.db, { exchangeId: ex.id, tenantId: TENANT_ID, to: "in_transit", notify });
      return ex;
    };
    const auditsFor = (exchangeId: string) =>
      world.db.select().from(schema.stockAdjustments)
        .where(and(eq(schema.stockAdjustments.tenantId, TENANT_ID), eq(schema.stockAdjustments.refId, exchangeId)));

    // ── (a) clean return ──
    const clean = await open(seed.toProductId);
    const received = await receiveExchange(world.db, { exchangeId: clean.id, tenantId: TENANT_ID, actorId: "merchant-1", notify });
    assert(received.status === "received", "received");
    assert(await stockOf(world, seed.fromProductId) === 21, "origin restocked 20→21");
    assert(await stockOf(world, seed.toProductId) === 9, "replacement reserved 10→9");
    const [snap] = await world.db.select().from(schema.inventorySnapshots)
      .where(and(eq(schema.inventorySnapshots.tenantId, TENANT_ID), eq(schema.inventorySnapshots.productId, seed.fromProductId)));
    assert(Number(snap.availableQty) === 19, `snapshot available 18→19 (got ${snap.availableQty})`);
    const [resv] = await world.db.select().from(schema.inventoryReservations)
      .where(and(eq(schema.inventoryReservations.orderId, seed.orderId), eq(schema.inventoryReservations.productId, seed.toProductId)));
    assert(resv && resv.status === "reserved" && resv.qty === 1, "claim-first reservation row written");
    const cleanAudit = await auditsFor(clean.id);
    const inRow = cleanAudit.find((r) => r.reason === "exchange_in");
    const outRow = cleanAudit.find((r) => r.reason === "exchange_out");
    assert(inRow && inRow.deltaQty === 1 && inRow.productId === seed.fromProductId && inRow.actorId === "merchant-1", "exchange_in audit row");
    assert(outRow && outRow.deltaQty === -1 && outRow.productId === seed.toProductId, "exchange_out audit row");

    // ── (b) damaged return: write-off, no restock ──
    const damaged = await open(seed.toProductId, true);
    const fromBefore = await stockOf(world, seed.fromProductId);
    await receiveExchange(world.db, { exchangeId: damaged.id, tenantId: TENANT_ID, notify });
    assert(await stockOf(world, seed.fromProductId) === fromBefore, "damaged goods NOT restocked");
    const dmgAudit = await auditsFor(damaged.id);
    const dmgRow = dmgAudit.find((r) => r.reason === "damage");
    assert(dmgRow && dmgRow.deltaQty === 0 && dmgRow.productId === seed.fromProductId, "damage write-off audit row");
    assert(dmgAudit.some((r) => r.reason === "exchange_out"), "replacement still reserved for damaged exchange");

    // ── (c) insufficient replacement stock: full rollback ──
    const doomed = await open(seed.emptyProductId);
    const fromBeforeFail = await stockOf(world, seed.fromProductId);
    let code: string | null = null;
    try {
      await receiveExchange(world.db, { exchangeId: doomed.id, tenantId: TENANT_ID, notify });
    } catch (e: any) { code = e?.code ?? "ERR"; }
    assert(code === "PRECONDITION_FAILED", `insufficient replacement stock refused (got ${code})`);
    const [row] = await world.db.select().from(schema.exchangeRequests).where(eq(schema.exchangeRequests.id, doomed.id));
    assert(row.status === "in_transit", `receipt rolled back, still in_transit (got ${row.status})`);
    assert(await stockOf(world, seed.fromProductId) === fromBeforeFail, "origin restock rolled back too");
    assert((await auditsFor(doomed.id)).length === 0, "no audit rows for a rolled-back receipt");
  },
};
