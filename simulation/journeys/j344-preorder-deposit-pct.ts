// === W44 preorders-offers (Coder B) ===
/**
 * J344 — Deposit-only pre-orders: tenants.preorderDepositPct (0-100, default
 * 100) is snapshotted into the preorder terms and the integer-cents deposit
 * is computed exactly (40% of ₦10,000.00 = 400000 kobo). An out-of-range pct
 * fails closed to 100 (full capture). A product whose availableAt is in the
 * PAST is NOT marked preorder (it is a normal line).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedPreorderProduct, setPreorderDepositPct } from "./w44-preorder-offer-seed";

export const journey: Journey = {
  id: "J344",
  name: "preorder deposit pct snapshot + past-availableAt is normal",
  feature: "tenants.preorderDepositPct + integer-cents deposit math",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { markPreorderLinesTx, preorderDepositCents, normalizeDepositPct } = await import("../../server/services/preorders");
    const prod = await seedPreorderProduct(world, "j344");

    // ── Deposit-only (40%): metadata snapshot carries the exact deposit ──
    await setPreorderDepositPct(world, 40);
    try {
      const orderId = `ord-j344-${Date.now().toString(36)}`;
      const lineId = crypto.randomUUID();
      await world.db.transaction(async (tx) => {
        await tx.insert(schema.orders).values({
          id: orderId,
          tenantId: TENANT_ID,
          customerId: world.newPhone("j344"),
          orderNumber: "W44-J344",
          status: "pending",
          totalAmount: "10000.00",
          currency: "NGN",
          paymentStatus: "unpaid",
          metadata: {},
        });
        await tx.insert(schema.orderItems).values({
          id: lineId, orderId, productId: prod.productId, productName: prod.name,
          quantity: 2, unitPrice: "5000.00", currency: "NGN",
        });
        await markPreorderLinesTx(tx as any, TENANT_ID, orderId, [
          { productId: prod.productId, qty: 2, orderLineId: lineId, unitPriceCents: 500000 },
        ]);
      });
      const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
      const pre = (ord.metadata as any).preorder;
      assert(pre.depositPct === 40, `depositPct 40 snapshotted (got ${pre.depositPct})`);
      assert(pre.totalCents === 1000000, "total 1000000 kobo");
      assert(pre.depositCents === 400000, `deposit 400000 kobo = 40% (got ${pre.depositCents})`);
    } finally {
      await setPreorderDepositPct(world, 100);
    }

    // ── Deposit math + normalization (pure, integer cents) ──
    assert(preorderDepositCents(1000000, 40) === 400000, "40% of ₦10k");
    assert(preorderDepositCents(999999, 50) === 500000, "rounds half up, never floats");
    assert(preorderDepositCents(1000000, 0) === 0, "0% deposit allowed");
    assert(normalizeDepositPct(150) === 100, "out-of-range pct fails closed to 100");
    assert(normalizeDepositPct(-5) === 100, "negative pct fails closed to 100");
    assert(normalizeDepositPct(40) === 40, "valid pct honored");

    // ── availableAt in the PAST → normal line, no preorder metadata ──
    const past = await seedPreorderProduct(world, "j344p", { availableAt: new Date(Date.now() - 60000) });
    const orderId2 = `ord-j344p-${Date.now().toString(36)}`;
    const lineId2 = crypto.randomUUID();
    const marked = await world.db.transaction(async (tx) => {
      await tx.insert(schema.orders).values({
        id: orderId2,
        tenantId: TENANT_ID,
        customerId: world.newPhone("j344p"),
        orderNumber: "W44-J344P",
        status: "pending",
        totalAmount: "5000.00",
        currency: "NGN",
        paymentStatus: "unpaid",
        metadata: {},
      });
      await tx.insert(schema.orderItems).values({
        id: lineId2, orderId: orderId2, productId: past.productId, productName: past.name,
        quantity: 1, unitPrice: "5000.00", currency: "NGN",
      });
      return markPreorderLinesTx(tx as any, TENANT_ID, orderId2, [
        { productId: past.productId, qty: 1, orderLineId: lineId2, unitPriceCents: 500000 },
      ]);
    });
    assert(marked.length === 0, "past availableAt → not marked preorder");
    const [line2] = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.id, lineId2));
    assert(line2.status === "ordered", `normal line stays ordered (got ${line2.status})`);
    const [ord2] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId2));
    assert(!(ord2.metadata as any)?.preorder, "no preorder metadata on normal order");

  },
};
