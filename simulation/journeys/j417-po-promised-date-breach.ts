// === W46 orders-p2 (Coder G) ===
/**
 * J417 — ORD-19: approving a PO stamps approvedAt + promisedDate
 * (= approvedAt + supplier leadTimeDays), and the breach sweep alerts the
 * buyer AND the supplier admin exactly once when the promise is breached.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, SUPPLIER_TENANT_ID, SUPPLIER_ADMIN_PHONE, type World } from "../world";
import type { Journey } from "../runner";
import { seedSupplierProfile, seedPo } from "./w46-orders-seed";

export const journey: Journey = {
  id: "J417",
  name: "PO promisedDate on approval + breach sweep alerts once",
  feature: "ORD-19 promisedDate + poBreach sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { approvePurchaseOrder, getPoById } = await import("../../server/services/procurement/poFlow");
    const { runPoBreachSweep, computePromisedDate } = await import("../../server/services/procurement/poBreach");

    await seedSupplierProfile(world, 7);
    const buyerPhone = world.newPhone("j417");
    const poId = await seedPo(world, "j417", { status: "submitted", buyerPhone });

    // Approve (paynow path) — payment link creation is best-effort in sim.
    const before = Date.now();
    const res = await approvePurchaseOrder(world.db, { poId });
    assert(res.ok, `approval succeeded (got ${JSON.stringify(res)})`);
    const po = await getPoById(world.db, poId);
    assert(po?.approvedAt, "approvedAt stamped on approval");
    assert(po?.promisedDate, "promisedDate stamped on approval");
    const deltaDays = (po!.promisedDate!.getTime() - po!.approvedAt!.getTime()) / 86_400_000;
    assert(deltaDays === 7, `promisedDate = approvedAt + 7d (got ${deltaDays}d)`);
    assert(computePromisedDate(po!.approvedAt!, 7).getTime() === po!.promisedDate!.getTime(), "helper matches stored date");
    void before;

    // Not yet breached → sweep finds nothing for this PO.
    let sweep = await runPoBreachSweep(world.db);
    assert(!sweep.alertedPoNumbers.includes(po!.poNumber), "no alert before the promise date");

    // Backdate the promise into the past → breach sweep alerts both sides.
    await world.db.update(schema.purchaseOrders)
      .set({ promisedDate: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(schema.purchaseOrders.id, poId));
    const buyerBefore = world.outbound.toPhone(buyerPhone).length;
    const supplierBefore = world.outbound.toPhone(SUPPLIER_ADMIN_PHONE).length;
    sweep = await runPoBreachSweep(world.db);
    assert(sweep.alertedPoNumbers.includes(po!.poNumber), `breach alerted (errors: ${sweep.errors.join(";")})`);
    await world.waitFor(
      () => world.outbound.findByBody("past its promised delivery date", buyerPhone).length > 0,
      5000,
      "buyer breach alert",
    );
    assert(world.outbound.toPhone(buyerPhone).length > buyerBefore, "buyer alerted");
    assert(world.outbound.toPhone(SUPPLIER_ADMIN_PHONE).length > supplierBefore, "supplier admin alerted");
    const after = await getPoById(world.db, poId);
    assert(after?.breachAlertedAt, "breachAlertedAt claimed");

    // Exactly-once: a second sweep sends nothing new.
    const buyerCount = world.outbound.toPhone(buyerPhone).length;
    const supplierCount = world.outbound.toPhone(SUPPLIER_ADMIN_PHONE).length;
    sweep = await runPoBreachSweep(world.db);
    assert(sweep.alerted === 0 || !sweep.alertedPoNumbers.includes(po!.poNumber), "second sweep does not re-alert");
    assert(world.outbound.toPhone(buyerPhone).length === buyerCount, "buyer not double-alerted");
    assert(world.outbound.toPhone(SUPPLIER_ADMIN_PHONE).length === supplierCount, "supplier not double-alerted");

    // A FULFILLED PO past its promise is never alerted post-hoc.
    const fulfilledId = await seedPo(world, "j417f", { status: "fulfilled", buyerPhone });
    await world.db.update(schema.purchaseOrders)
      .set({ promisedDate: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(schema.purchaseOrders.id, fulfilledId));
    sweep = await runPoBreachSweep(world.db);
    assert(sweep.alerted === 0, "fulfilled past-promise PO never alerted");
    void TENANT_ID; void SUPPLIER_TENANT_ID;
  },
};
// === END W46 orders-p2 ===
