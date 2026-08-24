/**
 * J172 — W30 (V3#9, V3#10): loyalty + voucher money locks.
 *   1. Concurrent redeems against one balance: exactly one wins (advisory
 *      lock serializes the balance read-then-write); balance conserved.
 *   2. The merchant redemption cap is enforced INSIDE redeemPoints (not
 *      just the advisory preview) — an over-cap redeem is rejected.
 *   3. Duplicate earn for the same order is an idempotent no-op (unique
 *      backstop), never double-awarded.
 *   4. Concurrent voucher issuances against one budget: the program row
 *      lock serializes; issuedCents never exceeds budgetCents.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J172",
  name: "loyalty concurrent redeem + cap + voucher budget lock",
  feature: "V3#9 + V3#10 remediation: balance locks, in-redeem cap, budget FOR UPDATE",
  async run(world: World) {
    const loyalty = await import("../../server/services/loyalty");
    const vouchers = await import("../../server/services/vouchers");
    const phone = world.newPhone("lr");
    await world.grantConsent(phone);

    // ── 1. Concurrent redeems: exactly one wins ──────────────────────────
    await loyalty.awardPoints({ tenantId: TENANT_ID, customerPhone: phone, points: 1_000, reason: "seed" }, world.db);
    const results = await Promise.allSettled([
      loyalty.redeemPoints({ tenantId: TENANT_ID, customerPhone: phone, points: 700, reason: "r1" }, world.db),
      loyalty.redeemPoints({ tenantId: TENANT_ID, customerPhone: phone, points: 700, reason: "r2" }, world.db),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter((r) => r.status === "rejected").length;
    assert(won === 1 && lost === 1, `concurrent redeems: exactly one wins (won=${won}, lost=${lost})`);
    const balance = await loyalty.getBalance(world.db, TENANT_ID, phone);
    assert(balance === 300, `balance conserved at 300 (got ${balance})`);

    // ── 2. Cap enforced inside redeemPoints ──────────────────────────────
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const orderCents = Math.round(order.total * 100); // 250,000
    await loyalty.awardPoints({ tenantId: TENANT_ID, customerPhone: phone, points: 5_000, reason: "seed2" }, world.db);
    // Default rules: 1pt = 100c, cap 20% → max discount 50,000c → 500 points.
    const overCap = await loyalty.redeemPoints(
      { tenantId: TENANT_ID, customerPhone: phone, points: 600, reason: "overcap", orderId: order.orderId }, world.db,
    ).then(() => null).catch((e: any) => e);
    assert(overCap instanceof Error, "over-cap redeem rejected inside redeemPoints");
    assert(String(overCap?.message).includes("cap"), `honest cap message (got: ${overCap?.message})`);
    const capped = await loyalty.redeemPoints(
      { tenantId: TENANT_ID, customerPhone: phone, points: 500, reason: "atcap", orderId: order.orderId }, world.db,
    );
    assert(capped.applied === true, "at-cap redeem (exactly 20%) succeeds");

    // ── 3. Duplicate earn per order is an idempotent no-op ───────────────
    const e1 = await loyalty.awardPoints(
      { tenantId: TENANT_ID, customerPhone: phone, points: 50, reason: "earn", orderId: order.orderId }, world.db);
    const e2 = await loyalty.awardPoints(
      { tenantId: TENANT_ID, customerPhone: phone, points: 50, reason: "earn", orderId: order.orderId }, world.db);
    assert(e1.applied === true && e2.applied === false, "second earn for same order is a no-op");
    assert(e2.balanceAfter === e1.balanceAfter, "duplicate earn never moves the balance");

    // ── 4. Voucher budget lock ───────────────────────────────────────────
    const program = await vouchers.createProgram(world.db, {
      tenantId: TENANT_ID, issuer: "Gov Sim", name: "J172 budget", budgetCents: 1_000,
    });
    const r1 = world.newPhone("vp");
    const r2 = world.newPhone("vq");
    const issues = await Promise.allSettled([
      vouchers.issueVouchers(world.db, { programId: program.id, recipients: [r1], amountCents: 800 }),
      vouchers.issueVouchers(world.db, { programId: program.id, recipients: [r2], amountCents: 800 }),
    ]);
    const issuedOk = issues.filter((r) => r.status === "fulfilled").length;
    const budgetBlocked = issues.filter((r) => r.status === "rejected" && String((r as any).reason?.message).includes("budget")).length;
    assert(issuedOk === 1 && budgetBlocked === 1, `budget race serialized (ok=${issuedOk}, blocked=${budgetBlocked})`);
    const schema = await import("../../drizzle/schema");
    const [fresh] = await world.db.select().from(schema.voucherPrograms).where(eq(schema.voucherPrograms.id, program.id));
    assert(fresh.issuedCents === 800, `issuedCents never exceeds budget (got ${fresh.issuedCents})`);
  },
};
