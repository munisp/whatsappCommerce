// === W46 uc-docs ===
/**
 * J402 — UC-12: per-customer statement of account aggregated from real
 * orders + payments: invoiced/paid/outstanding cents are correct, cancelled
 * orders excluded, regeneration idempotent (same period+currency reuses the
 * row), a customer with no activity is an honest NO_ACTIVITY error, and the
 * PDF exists on disk before the row claims 'generated'.
 */
import { existsSync } from "fs";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant, seedOrder } from "./w46-uc-docs-seed";

const PHONE = "2348040000402";

export const journey: Journey = {
  id: "J402",
  name: "customer statement of account from orders+payments",
  feature: "W46 uc-docs: UC-12 customer statements",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { computeCustomerStatement, generateCustomerStatement } = await import("../../server/services/customerStatements");
    const { ucDocsDir } = await import("../../server/services/ucDocsPdf");
    const { tenantId, caller } = await seedUcTenant(world, "402");

    const from = new Date(Date.now() - 30 * 86400000);
    const to = new Date(Date.now() + 86400000);

    // Two paid orders (₦4,000×2 = ₦8,000 each) + one cancelled (excluded).
    const o1 = await seedOrder(world, tenantId, "402a", PHONE, { unitPrice: "4000.00", qty: 2 });
    const o2 = await seedOrder(world, tenantId, "402b", PHONE, { unitPrice: "4000.00", qty: 2 });
    await seedOrder(world, tenantId, "402c", PHONE, { unitPrice: "9999.00", status: "cancelled", paid: false, paymentStatus: "unpaid" });

    const totals = await computeCustomerStatement(world.db, { tenantId, customerPhone: PHONE, from, to });
    assert(totals.length === 1, `one currency bucket (got ${totals.length})`);
    assert(totals[0]!.orderCount === 2, "cancelled order excluded from invoiced count");
    assert(totals[0]!.totalInvoicedCents === o1.totalCents + o2.totalCents, `invoiced = ${o1.totalCents + o2.totalCents} (got ${totals[0]!.totalInvoicedCents})`);
    assert(totals[0]!.paymentCount === 2, "two completed payments");
    assert(totals[0]!.totalPaidCents === totals[0]!.totalInvoicedCents, "fully paid → paid == invoiced");
    assert(totals[0]!.outstandingCents === 0, "outstanding zero");

    // One unpaid order → outstanding reflects it.
    await seedOrder(world, tenantId, "402d", PHONE, { unitPrice: "1500.00", qty: 1, paid: false, paymentStatus: "unpaid" });
    const gen = await caller.ucDocs.generateCustomerStatement({ tenantId, customerPhone: PHONE, from, to });
    assert(gen.statements.length === 1, "one statement row");
    const st = gen.statements[0]!;
    assert(st.status === "generated", "status generated");
    assert(st.orderCount === 3 && st.paymentCount === 2, "3 invoiced orders / 2 payments");
    assert(st.outstandingCents === 150000, `outstanding 150000 (got ${st.outstandingCents})`);
    assert(existsSync(join(ucDocsDir(), st.pdfPath)), "statement PDF on disk");

    // Regeneration: same period+currency reuses the row, no duplicate.
    const regen = await generateCustomerStatement(world.db, { tenantId, customerPhone: PHONE, from, to });
    assert(regen.statements.length === 1 && regen.statements[0]!.id === st.id, "regeneration reuses the row");
    assert(regen.statements[0]!.regenerated === true, "marked regenerated");
    const rows = await world.db.select().from(schema.customerStatements)
      .where(and(eq(schema.customerStatements.tenantId, tenantId), eq(schema.customerStatements.customerPhone, PHONE)));
    assert(rows.length === 1, `no duplicate statement rows (got ${rows.length})`);

    // No activity → honest error, never a fabricated zero statement.
    let noActivity = false;
    try {
      await generateCustomerStatement(world.db, { tenantId, customerPhone: "2348000000000", from, to });
    } catch (e: any) {
      noActivity = e?.code === "NO_ACTIVITY";
    }
    assert(noActivity, "NO_ACTIVITY for a stranger phone");

    // Tenant isolation: another tenant sees nothing for the same phone.
    const other = await computeCustomerStatement(world.db, { tenantId: "sim-w46-402-other", customerPhone: PHONE, from, to });
    assert(other.length === 0, "statements are tenant-scoped");
  },
};
