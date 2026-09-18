// === W46 privacy-consent (Coder B) ===
/**
 * J394 — TEN-17 buyer-side inter-tenant PO gates + cross-tenant dispute
 * routing (minimal honest version):
 *   - A buyer tenant WITHOUT an approved KYB cannot submit an inter-tenant
 *     PO (reason buyer_kyb_required) — buyer-side mirror of the supplier
 *     gate.
 *   - A suspended/churned tenant (buyer OR supplier side) cannot submit
 *     (tenant lifecycle propagates into poFlow).
 *   - The KYB-approved seed tenants keep the happy path.
 *   - A dispute on an inter-tenant (wholesale) order is ROUTED: the seller
 *     tenant is stamped as respondentTenantId; a retail dispute is untouched.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrderWithItem } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J394",
  name: "buyer KYB gate + suspension propagation + cross-tenant dispute routing",
  feature: "TEN-17 inter-tenant PO gates",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const poFlow = await import("../../server/services/procurement/poFlow");
    const lines = [{ name: "Polybag 50kg", qty: 10, unitPriceCents: 20_000 }]; // 200_000 >= MOQ

    // 1. Fresh tenant WITHOUT approved KYB → submit refused.
    await world.db.insert(schema.tenants).values({
      id: "t-j394-nokyb",
      name: "J394 NoKyb Retail",
      slug: "t-j394-nokyb",
      status: "active",
    }).onConflictDoNothing();
    const noKyb = await poFlow.submitPurchaseOrder(world.db, {
      buyerTenantId: "t-j394-nokyb",
      supplierTenantId: SUPPLIER_TENANT_ID,
      lines,
      paymentMode: "paynow",
    });
    assert(noKyb.ok === false && noKyb.reason === "buyer_kyb_required", `buyer KYB gate blocks (got ${noKyb.reason})`);

    // 2. Suspended BUYER tenant → refused; restore afterwards.
    await world.db.update(schema.tenants).set({ status: "suspended" }).where(eq(schema.tenants.id, TENANT_ID));
    const suspendedBuyer = await poFlow.submitPurchaseOrder(world.db, {
      buyerTenantId: TENANT_ID,
      supplierTenantId: SUPPLIER_TENANT_ID,
      lines,
      paymentMode: "paynow",
    });
    await world.db.update(schema.tenants).set({ status: "active" }).where(eq(schema.tenants.id, TENANT_ID));
    assert(suspendedBuyer.ok === false && suspendedBuyer.reason === "tenant_suspended",
      `suspended buyer blocked (got ${suspendedBuyer.reason})`);

    // 3. Suspended SUPPLIER tenant → refused.
    await world.db.update(schema.tenants).set({ status: "suspended" }).where(eq(schema.tenants.id, SUPPLIER_TENANT_ID));
    const suspendedSupplier = await poFlow.submitPurchaseOrder(world.db, {
      buyerTenantId: TENANT_ID,
      supplierTenantId: SUPPLIER_TENANT_ID,
      lines,
      paymentMode: "paynow",
    });
    await world.db.update(schema.tenants).set({ status: "active" }).where(eq(schema.tenants.id, SUPPLIER_TENANT_ID));
    assert(suspendedSupplier.ok === false && suspendedSupplier.reason === "tenant_suspended",
      `suspended supplier blocked (got ${suspendedSupplier.reason})`);

    // 4. Happy path: KYB-approved seed buyer + active supplier still submit.
    const ok = await poFlow.submitPurchaseOrder(world.db, {
      buyerTenantId: TENANT_ID,
      supplierTenantId: SUPPLIER_TENANT_ID,
      lines,
      paymentMode: "paynow",
    });
    assert(ok.ok === true && !!ok.po, `KYB-approved buyer submits (got ${ok.reason ?? "ok"})`);

    // 5. Cross-tenant dispute routing: dispute on a wholesale-linked order.
    const phone = world.newPhone("j394");
    const { orderId } = await seedOrderWithItem(world, "j394", phone);
    await world.db.insert(schema.wholesaleOrders).values({
      tenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      listingId: crypto.randomUUID(),
      quantity: 1,
      unitPriceCents: 10_000,
      totalCents: 10_000,
      orderId,
    });
    const { routeCrossTenantDispute } = await import("../../server/services/payments/disputes");
    const [dispute] = await world.db.insert(schema.paymentDisputes).values({
      tenantId: SUPPLIER_TENANT_ID,
      orderId,
      provider: "paystack",
      providerRef: `j394-ref-${Date.now()}`,
      kind: "dispute",
      amountCents: 10_000,
    }).returning({ id: schema.paymentDisputes.id });
    const routed = await routeCrossTenantDispute(world.db, dispute.id);
    assert(routed.routed === true && routed.buyerTenantId === TENANT_ID, "cross-tenant dispute routed to counterparty");
    const [stored] = await world.db.select().from(schema.paymentDisputes)
      .where(eq(schema.paymentDisputes.id, dispute.id));
    assert(stored.respondentTenantId === SUPPLIER_TENANT_ID, "respondent tenant stamped (seller responds)");

    // 6. Retail (single-tenant) dispute: NOT routed, respondent stays NULL.
    const [retail] = await world.db.insert(schema.paymentDisputes).values({
      tenantId: TENANT_ID,
      orderId: null,
      provider: "paystack",
      providerRef: `j394-retail-${Date.now()}`,
      kind: "dispute",
    }).returning({ id: schema.paymentDisputes.id });
    const notRouted = await routeCrossTenantDispute(world.db, retail.id);
    assert(notRouted.routed === false, "retail dispute untouched");
    const [retailRow] = await world.db.select().from(schema.paymentDisputes)
      .where(eq(schema.paymentDisputes.id, retail.id));
    assert(retailRow.respondentTenantId === null, "retail dispute keeps respondent NULL");
  },
};
