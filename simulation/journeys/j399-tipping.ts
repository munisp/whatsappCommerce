// === W46 uc-money (Coder C) ===
/**
 * J399 — UC-15 tipping: checkout prompt (tenant opt-in), TIP on a pending
 * order folds into the total in integer cents, tip rides through the escrow
 * split (fee + net == gross incl. tip), paid/terminal orders refuse tips,
 * foreign customers cannot tip someone else's order.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrderWithItem } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J399",
  name: "tip prompt + setOrderTip + escrow pass-through",
  feature: "UC-15 tipping",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const tipping = await import("../../server/services/tipping");
    const { splitEscrowAmounts, toMinorUnitsExact } = await import("../../shared/escrowAmounts");
    const phone = world.newPhone("j399");
    await world.grantConsent(phone);

    // ── Prompt: tenant opt-in renders a line; disabled tenant → null ──
    assert(tipping.buildTipCheckoutPrompt({ tipping: { enabled: true, suggestionsCents: [10000] } }, "NGN")?.includes("TIP"), "prompt renders when enabled");
    assert(tipping.buildTipCheckoutPrompt({ tipping: { enabled: false } }, "NGN") === null, "no prompt when disabled");
    assert(tipping.buildTipCheckoutPrompt(null, "NGN") === null, "no prompt without settings");

    // Tenant-level seam (reads tenants.settings).
    const [t] = await world.db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID));
    const prevSettings = t?.settings ?? {};
    await world.db.update(schema.tenants).set({
      settings: { ...(prevSettings as any), tipping: { enabled: true, suggestionsCents: [50000, 100000] } } as any,
    }).where(eq(schema.tenants.id, TENANT_ID));
    const line = await tipping.tipCheckoutPrompt(world.db, TENANT_ID, "NGN");
    assert(line && line.includes("TIP") && line.includes("500"), "tenant-level prompt seam reads settings");

    // ── Tip on a pending unpaid order folds into the total ──
    const seed = await seedOrderWithItem(world, "j399a", phone, { status: "pending", paymentStatus: "unpaid", qty: 2, unitPrice: "5000.00" });
    const r = await tipping.setOrderTip(world.db, { tenantId: TENANT_ID, customerRef: phone, tipCents: 75_000 });
    assert(r.orderId === seed.orderId && r.tipCents === 75_000, "tip resolves latest pending order");
    assert(r.totalCents === 1_000_000 + 75_000, "total = base + tip (integer cents)");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
    assert(ord.tipCents === 75_000 && Number(ord.totalAmount) === 10750, "orders.tipCents persisted");

    // Replace tip: total re-derives from base, not compounding.
    const r2 = await tipping.setOrderTip(world.db, { tenantId: TENANT_ID, customerRef: phone, tipCents: 50_000 });
    assert(r2.totalCents === 1_050_000, "tip replace re-derives from base");
    const r0 = await tipping.setOrderTip(world.db, { tenantId: TENANT_ID, customerRef: phone, tipCents: 0 });
    assert(r0.totalCents === 1_000_000, "tip 0 clears");

    // ── Escrow pass-through: split on total incl. tip conserves ──
    await tipping.setOrderTip(world.db, { tenantId: TENANT_ID, customerRef: phone, tipCents: 33_333 });
    const [ord2] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
    const split = splitEscrowAmounts(Number(ord2.totalAmount), 0.03125);
    assert(split.grossMinor === toMinorUnitsExact(String(ord2.totalAmount)), "escrow gross == order total incl tip");
    assert(split.feeMinor + split.netMinor === split.grossMinor, "fee + net == gross (pass-through conservation)");

    // ── Guards: paid order refuses tips; foreign phone cannot tip ──
    const paid = await seedOrderWithItem(world, "j399b", phone, { status: "pending", paymentStatus: "completed", qty: 1, unitPrice: "2000.00" });
    let paidBlocked = false;
    try {
      await tipping.setOrderTip(world.db, { tenantId: TENANT_ID, customerRef: phone, orderId: paid.orderId, tipCents: 100 });
    } catch (e: any) { paidBlocked = e?.code === "CONFLICT"; }
    assert(paidBlocked, "paid order refuses tips");

    const stranger = world.newPhone("j399x");
    let foreignBlocked = false;
    try {
      await tipping.setOrderTip(world.db, { tenantId: TENANT_ID, customerRef: stranger, orderId: seed.orderId, tipCents: 100 });
    } catch (e: any) { foreignBlocked = e?.code === "FORBIDDEN"; }
    assert(foreignBlocked, "foreign customer cannot tip another's order");

    // Restore tenant settings.
    await world.db.update(schema.tenants).set({ settings: prevSettings as any }).where(eq(schema.tenants.id, TENANT_ID));
  },
};
