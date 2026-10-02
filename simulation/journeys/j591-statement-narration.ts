// === W58 statements ===
/**
 * J591 — statement narration: every wallet_tx_type renders a plain-language
 * narration (never the raw enum) in the PDF lines, the narration table
 * covers the FULL enum, and per-row debit/credit signs come from the
 * recorded balances.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J591",
  name: "statement narration renders (no raw enum leaks)",
  feature: "W58 statements: narration templates + sign derivation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/walletStatements");

    // 1. Full enum coverage — the narration table can never drift from the
    //    wallet_tx_type enum (additive values must add a template).
    const enumValues = (schema.walletTxTypeEnum as any).enumValues as string[];
    for (const v of enumValues) {
      assert(svc.TX_NARRATION[v], `narration template missing for wallet tx type '${v}'`);
    }

    // 2. Plain-language rendering + ref interpolation.
    assert(svc.narrateTx("escrow_release", "#1234") === "Payment received — Order #1234", "order-ref narration");
    assert(svc.narrateTx("withdrawal", null) === "Withdrawal to bank", "bare withdrawal narration");
    assert(!svc.narrateTx("escrow_release", "#1234").includes("escrow_release"), "no enum leak");
    assert(svc.narrateTx("unknown_future_type", "R1") === "Wallet transaction — Ref R1", "unknown types degrade honestly");

    // 3. Sign derivation from balances (not the type name).
    assert(svc.rowIsDebit({ type: "wholesale_trade", balanceBefore: "100.00", balanceAfter: "60.00" }) === true, "wholesale debit leg");
    assert(svc.rowIsDebit({ type: "wholesale_trade", balanceBefore: "60.00", balanceAfter: "100.00" }) === false, "wholesale credit leg");
    assert(svc.rowIsDebit({ type: "escrow_release", balanceBefore: "0.00", balanceAfter: "50.00" }) === false, "credit row");

    // 4. A seeded ledger across types renders narrations in the PDF lines —
    //    and NO raw enum string appears anywhere in the document text.
    const { tenantId } = await seedUcTenant(world, "591", 5911);
    const walletId = "wal-w58-591";
    await world.db.insert(schema.merchantWallets).values({
      id: walletId, tenantId, availableBalance: "4650.00", currency: "NGN", isActive: true,
    }).onConflictDoNothing();
    await world.db.insert(schema.walletTransactions).values([
      { id: "wtx-591-1", walletId, tenantId, type: "escrow_release", amount: "10000.00", balanceBefore: "0.00", balanceAfter: "10000.00", currency: "NGN", reference: "J591A", createdAt: new Date("2025-08-03T10:00:00Z") },
      { id: "wtx-591-2", walletId, tenantId, type: "fee_deduction", amount: "350.00", balanceBefore: "10000.00", balanceAfter: "9650.00", currency: "NGN", reference: "J591B", createdAt: new Date("2025-08-04T10:00:00Z") },
      { id: "wtx-591-3", walletId, tenantId, type: "withdrawal", amount: "5000.00", balanceBefore: "9650.00", balanceAfter: "4650.00", currency: "NGN", reference: "J591C", createdAt: new Date("2025-08-10T10:00:00Z") },
    ] as any);
    const st = await svc.computeWalletStatement(world.db, {
      tenantId, from: new Date("2025-08-01T00:00:00Z"), to: new Date("2025-09-01T00:00:00Z"),
    });
    assert(st.lines[0]!.narration.startsWith("Payment received"), "credit narration");
    assert(st.lines[1]!.narration.startsWith("Platform fee") && st.lines[1]!.debitCents === 35_000, "fee is a signed debit");
    assert(st.lines[2]!.narration.startsWith("Withdrawal to bank") && st.lines[2]!.debitCents === 500_000, "withdrawal debit");
    const doc = svc.walletStatementPdfLines(st, { tenantName: "W58 591" }).join("\n");
    assert(doc.includes("Payment received") && doc.includes("Platform fee") && doc.includes("Withdrawal to bank"), "plain-language lines present");
    for (const v of enumValues) {
      assert(!doc.includes(v), `raw enum '${v}' must never render in the statement`);
    }
    // Totals row present with both debit and credit columns.
    assert(doc.includes("TOTALS"), "totals row renders");
  },
};
