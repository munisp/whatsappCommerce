/**
 * J133 — W27 bookkeeping: tax-ready export contents.
 * Seeds paid orders + confirmed expenses (in- and out-of-period), builds the
 * export, and asserts: summary block (total sales / expenses / net), section
 * contents, period filtering, integer-cents math, and the PDF rendering.
 * Also covers the WhatsApp "export" command delivering the portal link.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const FROM = "2026-02-01";
const TO = "2026-03-01";

export const journey: Journey = {
  id: "J133",
  name: "tax-ready export contents",
  feature: "W27 bookkeeping export",
  async run(world) {
    // Lazy import: top-level service imports would freeze server/_core/env
    // before bootWorld() points LLM/media URLs at the sim mocks.
    const { buildBookkeepingExport, exportToCsv, exportToPdf } = await import("../../server/services/bookkeeping");
    const schema = await import("../../drizzle/schema");
    // Isolated tenant: orders are not wiped between journeys.
    const EXP_TENANT = `exp-${crypto.randomUUID().slice(0, 8)}`;
    const mkOrder = async (day: string, total: string, tag: string) => {
      const at = new Date(`${day}T10:00:00.000Z`);
      await world.db.insert(schema.orders).values({
        id: crypto.randomUUID(), tenantId: EXP_TENANT, customerId: `c-${tag}`,
        orderNumber: `EXP-${tag}-${crypto.randomUUID().slice(0, 6)}`, status: "delivered",
        totalAmount: total, currency: "NGN", paymentStatus: "completed",
        createdAt: at, updatedAt: at,
      });
    };
    const mkExpense = async (day: string, cents: number, vendor: string, category = "stock") => {
      await world.db.insert(schema.expenses).values({
        tenantId: EXP_TENANT, amountCents: cents, vendor, category,
        expenseDate: new Date(`${day}T12:00:00.000Z`),
        status: "confirmed", source: "manual",
      });
    };

    // In-period: ₦25,000 + ₦17,300 sales; ₦1,500 + ₦4,200 expenses.
    await mkOrder("2026-02-03", "25000.00", "p1");
    await mkOrder("2026-02-10", "17300.00", "p2");
    await mkOrder("2026-01-15", "99999.00", "out"); // out of period
    await mkExpense("2026-02-05", 150000, "Chidi Supplies");
    await mkExpense("2026-02-12", 420000, "Lagos Logistics", "transport");
    await mkExpense("2026-01-20", 77700, "Old Vendor"); // out of period

    const from = new Date(`${FROM}T00:00:00.000Z`);
    const to = new Date(`${TO}T00:00:00.000Z`);
    const x = await buildBookkeepingExport(world.db, EXP_TENANT, from, to);

    assert(x.sales.length === 2, "export contains only in-period paid orders");
    assert(x.expenseRows.length === 2, "export contains only in-period confirmed expenses");
    assert(x.totalSalesCents === 4230000, `total sales integer cents (got ${x.totalSalesCents})`);
    assert(x.totalExpensesCents === 570000, `total expenses integer cents (got ${x.totalExpensesCents})`);
    assert(x.netCents === 4230000 - 570000, "net = sales − expenses");

    const csv = exportToCsv(x);
    assertIncludes(csv, `Period,${FROM},to,${TO}`, "CSV period header");
    assertIncludes(csv, "Total sales,42300.00", "CSV total sales");
    assertIncludes(csv, "Total expenses,5700.00", "CSV total expenses");
    assertIncludes(csv, "Net income,36600.00", "CSV net");
    assertIncludes(csv, "order_number,date,amount", "CSV sales header");
    assertIncludes(csv, "2026-02-03,25000.00", "CSV sales row");
    assertIncludes(csv, "date,vendor,category,amount", "CSV expense header");
    assertIncludes(csv, "2026-02-12,Lagos Logistics,transport,4200.00", "CSV expense row");
    assert(!csv.includes("99999"), "out-of-period sale excluded");
    assert(!csv.includes("Old Vendor"), "out-of-period expense excluded");

    const pdf = exportToPdf(x).toString("latin1");
    assertIncludes(pdf, "%PDF-1.4", "PDF header");
    assertIncludes(pdf, "Total sales:", "PDF summary line");
    assertIncludes(pdf, "Net income:", "PDF net line");

    // ── WhatsApp delivers the portal link ────────────────────────────────
    const merchant = world.newPhone("merchant");
    await world.grantConsent(merchant);
    await world.text(merchant, "export");
    const reply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(reply, "/portal/bookkeeping", "WhatsApp delivers the portal export link");

    // Digest log untouched by exports (export is read-only).
    const logs = await world.db.select().from(schema.bookkeepingDigestLog)
      .where(eq(schema.bookkeepingDigestLog.tenantId, TENANT_ID));
    assert(logs.length === 0, "export has no side effects");
  },
};
