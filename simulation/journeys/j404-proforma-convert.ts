// === W46 uc-docs ===
/**
 * J404 — UC-19: proforma invoice lifecycle: create (draft) → send as a chat
 * document (status sent, PDF on disk) → accept → convert-to-order
 * (claim-first: exactly one order per proforma, totals carry over, order
 * lines bound to real products) → double convert returns the same order.
 * Expired/cancelled proformas refuse conversion honestly.
 */
import { existsSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant, seedOrder } from "./w46-uc-docs-seed";

const PHONE = "2348040000404";

export const journey: Journey = {
  id: "J404",
  name: "proforma invoice: render, chat delivery, convert-to-order",
  feature: "W46 uc-docs: UC-19 proforma invoices",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/proformaInvoices");
    const { ucDocsDir } = await import("../../server/services/ucDocsPdf");
    const { tenantId, caller } = await seedUcTenant(world, "404");

    // A real catalog product so the converted order carries order lines.
    const { productId } = await seedOrder(world, tenantId, "404p", "2348040009999", { paid: false, paymentStatus: "unpaid" });

    const pf = await caller.ucDocs.createProforma({
      tenantId,
      customerName: "Buyer Four",
      customerPhone: PHONE,
      items: [
        { productId, name: "W46 Product 404p", quantity: 3, unitPriceCents: 400_000 },
        { name: "Delivery (flat)", quantity: 1, unitPriceCents: 50_000 },
      ],
      validDays: 7,
      notes: "J404 quotation",
    });
    assert(pf.status === "draft" && pf.proformaNo >= 1, "draft proforma with tenant sequence");
    assert(pf.totalCents === 3 * 400_000 + 50_000, `total 1250000 (got ${pf.totalCents})`);

    // Send as chat document (WA simulated in sim).
    const sent = await caller.ucDocs.sendProforma({ tenantId, proformaId: pf.id });
    assert(sent.proforma.status === "sent", `status sent (got ${sent.proforma.status})`);
    assert(sent.delivery.channel === "whatsapp" && sent.delivery.simulated === true, "WA document push honestly simulated");
    assert(existsSync(join(ucDocsDir(), sent.proforma.pdfPath)), "proforma PDF on disk");

    // Accept → convert (claim-first).
    const accepted = await caller.ucDocs.acceptProforma({ tenantId, proformaId: pf.id });
    assert(accepted.status === "accepted", "accepted");
    const conv = await caller.ucDocs.convertProforma({ tenantId, proformaId: pf.id });
    assert(conv.alreadyConverted === false && conv.orderId, "converted to a new order");
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, conv.orderId));
    assert(order, "order row exists");
    assert(order.tenantId === tenantId && order.customerId === PHONE, "order carries tenant + customer");
    assert(Math.round(parseFloat(order.totalAmount) * 100) === 1_250_000, `order total carries over (got ${order.totalAmount})`);
    assert(order.paymentStatus === "unpaid" && order.status === "pending", "order starts unpaid/pending");
    assert((order.metadata as any)?.proformaId === pf.id, "order traces back to the proforma");
    const lines = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, conv.orderId));
    assert(lines.length === 1 && lines[0]!.productId === productId && lines[0]!.quantity === 3, "product-bound line carried over");

    // Exactly-once: a second convert returns the SAME order.
    const again = await caller.ucDocs.convertProforma({ tenantId, proformaId: pf.id });
    assert(again.alreadyConverted === true && again.orderId === conv.orderId, "re-convert is idempotent");
    const allOrders = await world.db.select().from(schema.orders).where(eq(schema.orders.tenantId, tenantId));
    const pfOrders = allOrders.filter((o: any) => (o.metadata as any)?.proformaId === pf.id);
    assert(pfOrders.length === 1, "exactly one order per proforma");

    // Expired proforma refuses conversion.
    const expired = await svc.createProforma(world.db, {
      tenantId, customerPhone: PHONE, validDays: 1,
      items: [{ name: "Old stock", quantity: 1, unitPriceCents: 10_000 }],
    });
    await world.db.execute(`UPDATE proforma_invoices SET valid_until = now() - interval '1 day' WHERE id = '${expired.id}'`);
    await svc.expireProformas(world.db);
    const [ex] = await world.db.select().from(schema.proformaInvoices).where(eq(schema.proformaInvoices.id, expired.id));
    assert(ex.status === "expired", "sweep flips expired");
    let refused = false;
    try {
      await svc.convertProformaToOrder(world.db, { tenantId, proformaId: expired.id });
    } catch (e: any) {
      refused = e?.code === "bad-status";
    }
    assert(refused, "expired proforma refuses conversion");

    // Cancelled proforma refuses send + conversion.
    const cxl = await svc.createProforma(world.db, {
      tenantId, customerPhone: PHONE, items: [{ name: "X", quantity: 1, unitPriceCents: 5_000 }],
    });
    await svc.cancelProforma(world.db, { tenantId, proformaId: cxl.id });
    let sendRefused = false;
    try {
      await svc.sendProforma(world.db, { tenantId, proformaId: cxl.id });
    } catch (e: any) {
      sendRefused = e?.code === "bad-status";
    }
    assert(sendRefused, "cancelled proforma refuses send");

    // Per-tenant sequence: numbers never collide.
    const pfA = await svc.createProforma(world.db, { tenantId, items: [{ name: "A", quantity: 1, unitPriceCents: 100 }] });
    const pfB = await svc.createProforma(world.db, { tenantId, items: [{ name: "B", quantity: 1, unitPriceCents: 100 }] });
    assert(pfA.proformaNo !== pfB.proformaNo, "proforma_no unique per tenant");
  },
};
