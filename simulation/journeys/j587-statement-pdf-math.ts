// === W58 statements ===
/**
 * J587 — merchant wallet statement PDF math: opening/closing balances are
 * computed from the real seeded ledger (opening = last balance BEFORE the
 * period, closing = last in-period balanceAfter), totals row matches, and an
 * EMPTY period is honest (opening carried forward, zero totals, explicit
 * "no transactions" line — nothing fabricated).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J587",
  name: "wallet statement PDF: opening/closing math from seeded ledger",
  feature: "W58 statements: walletStatements.compute/generate",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/walletStatements");
    const { ucDocsDir } = await import("../../server/services/ucDocsPdf");
    const { tenantId } = await seedUcTenant(world, "587", 5801);
    const walletId = "wal-w58-587";

    await world.db.insert(schema.merchantWallets).values({
      id: walletId, tenantId, availableBalance: "6750.00", currency: "NGN", isActive: true,
    }).onConflictDoNothing();

    const tx = (id: string, type: any, amount: string, before: string, after: string, at: string, reference?: string) => ({
      id, walletId, tenantId, type, amount, balanceBefore: before, balanceAfter: after,
      currency: "NGN", reference: reference ?? null, createdAt: new Date(at),
    });
    // Prior-period history: July credit lands at 2000.00.
    await world.db.insert(schema.walletTransactions).values([
      tx("wtx-587-0", "escrow_release", "2000.00", "0.00", "2000.00", "2025-07-15T10:00:00Z", "J587-JUL"),
      // August ledger: +10000 (escrow_release), −250 (fee), −5000 (withdrawal).
      tx("wtx-587-1", "escrow_release", "10000.00", "2000.00", "12000.00", "2025-08-03T10:00:00Z", "J587-A"),
      tx("wtx-587-2", "fee_deduction", "250.00", "12000.00", "11750.00", "2025-08-04T10:00:00Z", "J587-B"),
      tx("wtx-587-3", "withdrawal", "5000.00", "11750.00", "6750.00", "2025-08-20T10:00:00Z", "J587-C"),
    ] as any);

    const from = new Date("2025-08-01T00:00:00Z");
    const to = new Date("2025-09-01T00:00:00Z");
    const st = await svc.computeWalletStatement(world.db, { tenantId, from, to });
    assert(st.openingCents === 200_000, `opening = July closing 2000.00 (got ${st.openingCents})`);
    assert(st.closingCents === 675_000, `closing = last August balanceAfter 6750.00 (got ${st.closingCents})`);
    assert(st.totalCreditCents === 1_000_000 && st.totalDebitCents === 525_000,
      `totals row: credit 10000 / debit 5250 (got ${st.totalCreditCents}/${st.totalDebitCents})`);
    assert(st.txCount === 3, "3 in-period lines");

    const gen = await svc.generateWalletStatement(world.db, { tenantId, from, to });
    assert(gen.regenerated === false, "first generation is not a regeneration");
    const abs = join(ucDocsDir(), gen.record.pdfPath);
    assert(existsSync(abs), "PDF persisted under the private uc-docs prefix");
    assert(gen.record.pdfPath.startsWith(`${tenantId}/wallet-statements/`), "tenant-scoped private prefix");
    assert(gen.record.pdfPath.includes("statement-2025-08-01_2025-09-01.pdf"), "deterministic filename");
    const pdfText = readFileSync(abs, "utf8");
    assert(pdfText.includes("Opening balance: NGN 2,000.00"), "PDF renders opening balance");
    assert(pdfText.includes("Closing balance: NGN 6,750.00"), "PDF renders closing balance");

    // Idempotent regeneration: same key, regenerated flag, single manifest entry.
    const regen = await svc.generateWalletStatement(world.db, { tenantId, from, to });
    assert(regen.regenerated === true && regen.record.id === gen.record.id, "regeneration reuses the manifest entry");
    assert(svc.listWalletStatements(tenantId).length === 1, "one manifest entry after regeneration");

    // Empty period (Sept 2025): honest carry-forward, zero totals.
    const empty = await svc.computeWalletStatement(world.db, {
      tenantId, from: new Date("2025-09-01T00:00:00Z"), to: new Date("2025-10-01T00:00:00Z"),
    });
    assert(empty.txCount === 0, "empty period has no lines");
    assert(empty.openingCents === 675_000 && empty.closingCents === 675_000,
      "empty period: opening carried forward from last prior tx, closing == opening");
    assert(empty.totalCreditCents === 0 && empty.totalDebitCents === 0, "empty period zero totals");
    const emptyLines = svc.walletStatementPdfLines(empty, { tenantName: "W58 587" });
    assert(emptyLines.some((l) => l.includes("no transactions in this period")), "empty period says so honestly");
  },
};
