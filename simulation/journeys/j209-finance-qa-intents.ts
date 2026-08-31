/**
 * === W33 ai-qa-forecast (Coder B) ===
 * J209 — AP/AR AI Q&A over WhatsApp: the 6 canonical finance intents answer
 * with REAL figures from tenant-scoped queries (seeded vendor bills + AR
 * invoices), via the deterministic keyword fallback (no LLM scripted — the
 * assistant answers even when the NL layer is unavailable). Mixed figures
 * are integer cents formatted exactly; a non-finance message falls through
 * to the existing pipeline.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J209",
  name: "WhatsApp finance Q&A: 6 canonical intents answer real figures",
  feature: "W33 financeQa: keyword fallback, tenant-scoped real queries, honest amounts",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    const in3d = new Date(Date.now() + 3 * 86_400_000);
    const in30d = new Date(Date.now() + 30 * 86_400_000);
    const phone = world.newPhone("qa");
    await world.grantConsent(phone);

    // Seed AP: two open bills (one due this week, one due in 30 days).
    await world.db.insert(schema.vendorBills).values([
      {
        tenantId: TENANT_ID, vendorName: "QA Flour Mills", amountCents: 250_000,
        paidCents: 0, currency: "NGN", status: "pending", dueDate: in3d,
        captureSource: "manual", createdAt: now, updatedAt: now,
      },
      {
        tenantId: TENANT_ID, vendorName: "QA Sugar Co", amountCents: 900_000,
        paidCents: 100_000, currency: "NGN", status: "partially_paid", dueDate: in30d,
        captureSource: "manual", createdAt: now, updatedAt: now,
      },
    ]);

    // Seed AR: invoice #9001 partially paid, invoice #9002 paid in full.
    await world.db.insert(schema.arInvoices).values([
      {
        tenantId: TENANT_ID, customerName: "QA Buyer Amara", customerPhone: phone,
        invoiceNo: 9001, amountCents: 400_000, paidCents: 150_000, currency: "NGN",
        status: "partially_paid", dueDate: in3d, createdAt: now, updatedAt: now,
      },
      {
        tenantId: TENANT_ID, customerName: "QA Buyer Bello", customerPhone: phone,
        invoiceNo: 9002, amountCents: 120_000, paidCents: 120_000, currency: "NGN",
        status: "paid", paidAt: now, dueDate: in3d, createdAt: now, updatedAt: now,
      },
    ]);

    // 1. bills due this week — only the ₦2,500.00 bill (the other is 30d out).
    await world.text(phone, "bills due this week");
    let reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("QA Flour Mills"), `bills_due names the vendor (got: ${reply})`);
    assert(reply.includes("₦2,500"), `bills_due real amount ₦2,500 (got: ${reply})`);
    assert(!reply.includes("QA Sugar Co"), `bills_due excludes the 30-day bill (got: ${reply})`);

    // 2. who do I owe most — QA Sugar Co has ₦8,000 open > ₦2,500.
    await world.text(phone, "who do I owe most");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("QA Sugar Co") && reply.includes("₦8,000"), `top_creditor real open balance (got: ${reply})`);

    // 3. invoice paid? — by number, both states honest.
    await world.text(phone, "has invoice 9002 been paid?");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("PAID") && reply.includes("₦1,200"), `invoice_paid paid state (got: ${reply})`);
    await world.text(phone, "invoice 9001 paid?");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("PARTIALLY PAID") && reply.includes("₦2,500") && reply.includes("₦1,500"),
      `invoice_paid partial state with real remaining (got: ${reply})`);

    // 4. expected inflows — open AR ₦2,500 (invoice 9001 remaining).
    await world.text(phone, "expected inflows");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("₦2,500"), `expected_inflows real open AR (got: ${reply})`);

    // 5. who owes me most — only one open debtor.
    await world.text(phone, "who owes me most");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("QA Buyer Amara") && reply.includes("₦2,500"), `top_debtor real customer (got: ${reply})`);

    // 6. cash forecast — computed structure, no fabricated numbers.
    await world.text(phone, "cash forecast");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(reply.includes("Next 30 days"), `cash_forecast summary (got: ${reply})`);
    // Outflows within 30d: 2,500 + 8,000 = ₦10,500.
    assert(reply.includes("₦10,500"), `cash_forecast real outflow total (got: ${reply})`);

    // Fallthrough: a non-finance message is NOT intercepted by the Q&A layer.
    await world.text(phone, "hello there");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(!reply.includes("Next 30 days") && !reply.includes("owes you the most") && !reply.includes("bills due"),
      `non-finance message falls through (got: ${reply})`);

    // Cross-tenant honesty: another tenant's bills never appear.
    const [other] = await world.db.insert(schema.tenants).values({
      id: "sim-w33-209-other", name: "Other", slug: "sim-w33-209-other", status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning({ id: schema.tenants.id });
    await world.db.insert(schema.vendorBills).values({
      tenantId: other?.id ?? "sim-w33-209-other", vendorName: "CrossTenant Vendor",
      amountCents: 9_999_900, paidCents: 0, currency: "NGN", status: "pending",
      dueDate: in3d, captureSource: "manual", createdAt: now, updatedAt: now,
    });
    await world.text(phone, "who do I owe most");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assert(!reply.includes("CrossTenant Vendor"), `no cross-tenant leakage (got: ${reply})`);
    // cleanup of the probe rows (bill rows are wiped by the W31 seam anyway)
    await world.db.delete(schema.vendorBills)
      .where(and(eq(schema.vendorBills.vendorName, "CrossTenant Vendor")));
  },
};
// === END W33 ai-qa-forecast ===
