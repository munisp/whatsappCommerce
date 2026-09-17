// === W44 preorders-offers (Coder B) ===
/**
 * J342 — Pre-order checkout marking + availability flip: lines of a
 * preorder-enabled product (future availableAt) are stamped 'preorder' with
 * a metadata terms snapshot inside the SAME order transaction; when
 * availableAt passes, the lazy sweeper flips them to 'ordered' claim-first
 * (replay flips nothing) and the customer is notified on their channel via
 * the registered 'preorder_status' parity category.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedPreorderProduct } from "./w44-preorder-offer-seed";

export const journey: Journey = {
  id: "J342",
  name: "preorder checkout marks line + sweeper flips on availability",
  feature: "orderCrud seam + lazy sweeper + both-channel notify",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { markPreorderLinesTx, sweepDuePreorders } = await import("../../server/services/preorders");
    const phone = world.newPhone("j342");
    await world.grantConsent(phone);
    const prod = await seedPreorderProduct(world, "j342");

    // ── Checkout seam: line stamped 'preorder' + metadata snapshot ──
    const orderId = `ord-j342-${Date.now().toString(36)}`;
    const lineId = crypto.randomUUID();
    await world.db.transaction(async (tx) => {
      await tx.insert(schema.orders).values({
        id: orderId,
        tenantId: TENANT_ID,
        customerId: phone,
        orderNumber: "W44-J342",
        status: "pending",
        totalAmount: "10000.00",
        currency: "NGN",
        paymentStatus: "unpaid",
        metadata: {},
      });
      await tx.insert(schema.orderItems).values({
        id: lineId,
        orderId,
        productId: prod.productId,
        productName: prod.name,
        quantity: 2,
        unitPrice: "5000.00",
        currency: "NGN",
      });
      const marked = await markPreorderLinesTx(tx as any, TENANT_ID, orderId, [
        { productId: prod.productId, qty: 2, orderLineId: lineId, unitPriceCents: 500000 },
      ]);
      assert(marked.length === 1 && marked[0] === lineId, "line marked preorder in-txn");
    });
    const [line] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.id, lineId));
    assert(line.status === "preorder", `line status preorder (got ${line.status})`);
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    const pre = (ord.metadata as any).preorder;
    assert(pre, "preorder metadata snapshot");
    assert(pre.depositPct === 100, `default depositPct 100 (got ${pre.depositPct})`);
    assert(pre.totalCents === 1000000 && pre.depositCents === 1000000, "integer-cents totals");
    assert(pre.availableAt === prod.availableAt.toISOString(), "availableAt snapshotted");

    // Parity category registered (subset semantics — presence, not counts).
    const { getParityCategory } = await import("../../server/services/channelParity");
    assert(!!getParityCategory("preorder_status"), "preorder_status parity category registered");

    // ── Not due yet: sweeper flips nothing ──
    const early = await sweepDuePreorders({ db: world.db });
    const [still] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.id, lineId));
    assert(still.status === "preorder", "not due → still preorder");
    assert(early.linesFlipped === 0, "early sweep flips nothing");

    // ── Availability reached → flip to 'ordered' + customer notified ──
    await world.backdate(
      `UPDATE products SET "preorderAvailableAt" = now() - interval '1 minute' WHERE id = $1`,
      [prod.productId],
    );
    const run = await sweepDuePreorders({ db: world.db });
    assert(run.linesFlipped === 1 && run.ordersFlipped === 1, `flipped one line (got ${JSON.stringify(run)})`);
    const [flipped] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.id, lineId));
    assert(flipped.status === "ordered", `flipped to ordered (got ${flipped.status})`);
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phone);
      return !!t && bodyText(t).includes("pre-order");
    }, 10000, "customer availability notification");
    const notif = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(notif, "fulfillment", "notification announces fulfillment");

    // ── Idempotent replay: second sweep flips nothing, no second notice ──
    const before = world.outbound.all().length;
    const replay = await sweepDuePreorders({ db: world.db });
    assert(replay.linesFlipped === 0, "replay flips nothing");
    assert(world.outbound.all().length === before, "no duplicate notification");

    // ── Flipped lines enter normal fulfillment (W43 path unchanged) ──
    await world.db.update(schema.orders).set({ status: "confirmed", paymentStatus: "completed" })
      .where(eq(schema.orders.id, orderId));
    const { fulfillOrderLines } = await import("../../server/services/orderFulfill");
    const f = await fulfillOrderLines(world.db as any, {
      tenantId: TENANT_ID,
      orderId,
      lines: [{ orderLineId: lineId, qty: 2 }],
    });
    assert(f.orderStatus === "shipped", `normal fulfillment after flip (got ${f.orderStatus})`);
    const [check] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.id, lineId));
    assert(check.status === "ordered", "line remains ordered through fulfillment");
    void and;
  },
};
