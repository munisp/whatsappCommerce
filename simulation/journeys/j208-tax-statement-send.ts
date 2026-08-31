/**
 * J208 — W33 tax-statements (Coder A): send via WhatsApp document push →
 * honest 'sent' (simulated send labelled, no fake wamid), supplier read →
 * 'viewed', regeneration idempotent (unique key + file replaced, no dup row).
 */
import { existsSync } from "fs";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const T = "sim-tax-208";
const SUP = "sim-tax-208s";

export const journey: Journey = {
  id: "J208",
  name: "statement send via WA push + viewed + idempotent regeneration",
  feature: "W33 tax-statements",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const YEAR = new Date().getUTCFullYear();
    await world.db.insert(schema.tenants).values({
      id: T, name: "W33 Tax 208", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenants).values({
      id: SUP, name: "Supplier Co 208", slug: SUP, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "2081", role: "owner",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: SUP, userId: "2082", role: "owner",
    }).onConflictDoNothing();
    const payer = await tenantCaller(T, { userId: 2081 });
    const supplier = await tenantCaller(SUP, { userId: 2082 });

    // Supplier profile (platform supplier tenant) with a phone for the push.
    await payer.taxStatements.upsertProfile({
      tenantId: T,
      supplierTenantId: SUP,
      vendorName: "Supplier Co 208",
      phone: "+2348011122208",
    });

    // Attributed payout to the supplier tenant (real wallet_tx record).
    await world.db.insert(schema.merchantWallets)
      .values({ tenantId: T, availableBalance: "1000.00" })
      .onConflictDoNothing();
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    await world.db.insert(schema.walletTransactions).values({
      walletId: wallet.id,
      tenantId: T,
      type: "withdrawal",
      amount: "750.00",
      balanceBefore: "1000.00",
      balanceAfter: "250.00",
      currency: "NGN",
      description: "Payout to Supplier Co 208",
      reference: `payout:${SUP}:208`,
      metadata: { supplierRef: `tenant:${SUP}`, supplierName: "Supplier Co 208" },
      createdAt: new Date(),
    });

    // ── Generate ─────────────────────────────────────────────────────────
    const gen = await payer.taxStatements.generateAnnualStatement({
      tenantId: T, supplierRef: SUP, year: YEAR,
    });
    assert(gen.statements.length === 1, "one statement (single currency)");
    const st = gen.statements[0];
    assert(st.supplierTenantId === SUP, "statement addressed to supplier tenant");
    assert(st.totalPaidCents === 75000, "total matches the payout withdrawal");

    // ── Send via WhatsApp document push (sim → honest simulated label) ───
    const sent = await payer.taxStatements.sendStatement({
      tenantId: T, statementId: st.id,
    });
    assert(sent.statement.status === "sent", `status sent (got ${sent.statement.status})`);
    assert(sent.statement.sentAt, "sent_at recorded");
    // No WA creds in sim → honestly simulated, no fabricated wamid.
    assert(sent.wa.simulated === true && sent.wa.sent === false, "send honestly labelled simulated");
    assert(sent.statement.waMessageId === null, "no fake message id");

    // ── Supplier read → viewed ───────────────────────────────────────────
    const inbox = await supplier.taxStatements.supplierInbox({ tenantId: SUP });
    assert(inbox.length === 1 && inbox[0].id === st.id, "supplier sees the statement in its inbox");
    const viewed = await supplier.taxStatements.markViewed({ tenantId: SUP, statementId: st.id });
    assert(viewed.status === "viewed", `viewed on supplier read (got ${viewed.status})`);

    // A different tenant cannot mark it viewed.
    const stranger = await payer.taxStatements.markViewed({ tenantId: T, statementId: st.id }).catch((e: any) => e);
    assert(stranger?.code === "FORBIDDEN" || stranger?.data?.code === "FORBIDDEN", "payer cannot self-mark viewed");

    // ── Regeneration idempotent: same unique key, no dup, file replaced ──
    const regen = await payer.taxStatements.generateAnnualStatement({
      tenantId: T, supplierRef: SUP, year: YEAR,
    });
    assert(regen.statements.length === 1, "still one statement row");
    const re = regen.statements[0];
    assert(re.id === st.id, "regeneration reuses the same row (unique key)");
    assert(re.regenerated === true && re.changed === false, "unchanged figures → no status regression");
    assert(re.status === "viewed", "status preserved when figures unchanged");
    const { statementsDir } = await import("../../server/services/supplierTaxStatements");
    assert(existsSync(join(statementsDir(), re.pdfPath)), "PDF file still on disk after regeneration");
    const rows = await world.db.select().from(schema.annualStatements)
      .where(and(eq(schema.annualStatements.tenantId, T), eq(schema.annualStatements.year, YEAR)));
    assert(rows.length === 1, `unique(tenant,supplier,year,currency) holds (got ${rows.length})`);
  },
};
