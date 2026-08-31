/**
 * J207 — W33 tax-statements (Coder A): annual statement PDF generated
 * honestly (file exists on disk BEFORE status 'generated'), mixed-currency
 * year → TWO statement rows (never summed across currencies), withholding
 * labelled informationally.
 */
import { existsSync, statSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const T = "sim-tax-207";
const VREF = "acme-parts";

async function fundWallet(world: World, tenantId: string, balance: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.merchantWallets)
    .values({ tenantId, availableBalance: balance })
    .onConflictDoNothing();
  await world.db.update(schema.merchantWallets)
    .set({ availableBalance: balance, updatedAt: new Date() })
    .where(eq(schema.merchantWallets.tenantId, tenantId));
}

export const journey: Journey = {
  id: "J207",
  name: "annual statement PDF honest generation + mixed currency",
  feature: "W33 tax-statements",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const YEAR = new Date().getUTCFullYear();
    await world.db.insert(schema.tenants).values({
      id: T, name: "W33 Tax 207", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "2071", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 2071 });
    await fundWallet(world, T, "9000.00");

    // Profile WITH withholding (5%) — informational labelling only.
    await caller.taxStatements.upsertProfile({
      tenantId: T,
      vendorName: "Acme Parts",
      vendorRef: VREF,
      taxId: "VAT-998877",
      taxIdType: "vat",
      countryCode: "NG",
      withholdingBps: 500,
    });

    // Same supplier, TWO currencies in the same year.
    const ngn = await caller.vendorBills.create({
      tenantId: T, vendorName: "Acme Parts", amountCents: 200000, currency: "NGN", vendorRef: VREF,
    });
    const usd = await caller.vendorBills.create({
      tenantId: T, vendorName: "Acme Parts", amountCents: 30000, currency: "USD", vendorRef: VREF,
    });
    await caller.vendorBills.recordPayment({ tenantId: T, billId: ngn.bill.id });
    await caller.vendorBills.recordPayment({ tenantId: T, billId: usd.bill.id });

    const gen = await caller.taxStatements.generateAnnualStatement({
      tenantId: T, supplierRef: VREF, year: YEAR,
    });
    assert(gen.statements.length === 2, `mixed currency → 2 statements (got ${gen.statements.length})`);
    const byCur = Object.fromEntries(gen.statements.map((s: any) => [s.currency, s]));
    assert(byCur.NGN && byCur.USD, "one statement per currency");
    assert(byCur.NGN.totalPaidCents === 200000 && byCur.USD.totalPaidCents === 30000,
      "per-currency totals, never summed across");

    // ── PDF honesty: file exists BEFORE status 'generated' ───────────────
    const { statementsDir } = await import("../../server/services/supplierTaxStatements");
    for (const s of gen.statements as any[]) {
      assert(s.status === "generated", `status generated (got ${s.status})`);
      const abs = join(statementsDir(), s.pdfPath);
      assert(existsSync(abs), `PDF file exists on disk: ${s.pdfPath}`);
      const buf = statSync(abs);
      assert(buf.size > 200, `PDF non-trivial (${buf.size} bytes)`);
    }
    // Withholding labelled informationally (5% of 200000 = 10000).
    assert(byCur.NGN.withholdingCents === 10000, `withholding labelled (got ${byCur.NGN.withholdingCents})`);
    const { WITHHOLDING_NOTE } = await import("../../server/services/supplierTaxStatements");
    assert(/INFORMATIONAL ONLY/.test(WITHHOLDING_NOTE), "withholding note is honest (no rail exists)");

    // ── A supplier with no payments is an honest error, not a zero PDF ───
    const none = await caller.taxStatements.generateAnnualStatement({
      tenantId: T, supplierRef: "nobody", year: YEAR,
    }).catch((e: any) => e);
    assert(/NO_PAYMENTS/.test(none?.message ?? ""), "no payments → honest NO_PAYMENTS error");

    // ── listStatements reflects the rows ─────────────────────────────────
    const listed = await caller.taxStatements.listStatements({ tenantId: T, year: YEAR });
    assert(listed.length === 2, `listStatements sees both (got ${listed.length})`);
  },
};
