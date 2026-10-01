// === W56 credit ===
/**
 * J574 — adjustFeeBps FUTURE-ONLY semantics: the fee snapshot on the credit
 * account moves (150→250 bps) while every existing credit_ledger row —
 * settled AND posted — is byte-untouched (append-only ledger). Audit =
 * zero-amount 'adjustment' ledger note + audit_logs row. Idempotent re-call
 * with the same value is an honest no-op; closed accounts refuse; reason is
 * mandatory.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J574",
  name: "adjustFeeBps applies to future accruals only — settled rows untouched",
  feature: "W56 credit servicing: fee re-point, append-only audit, idempotent no-op",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/creditServicing");

    const sup = `j574-sup`;
    const buy = `j574-buy`;
    const buyerPhone = world.newPhone("574").replace(/\D/g, "");
    for (const [id, name] of [[sup, "J574 Supplier"], [buy, "J574 Buyer"]] as const) {
      await world.db.insert(schema.tenants).values({ id, name, slug: id, status: "active" }).onConflictDoNothing();
    }
    await world.db.update(schema.tenants)
      .set({ settings: { adminPhone: buyerPhone } })
      .where(eq(schema.tenants.id, buy));

    const accountId = crypto.randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId, supplierTenantId: sup, buyerTenantId: buy,
      limitCents: 10_000_000, outstandingCents: 600_000, termsDays: 30, status: "active", feeBps: 150,
    });
    // One SETTLED draw + one SETTLED fee row + one still-posted draw.
    const settledDrawId = crypto.randomUUID();
    const settledFeeId = crypto.randomUUID();
    const openDrawId = crypto.randomUUID();
    await world.db.insert(schema.creditLedger).values([
      { id: settledDrawId, creditAccountId: accountId, kind: "invoice_draw", amountCents: 500_000, status: "settled", dueDate: new Date(Date.now() - 40 * 86400_000), ref: "draw:j574:a", note: "settled long ago" },
      { id: settledFeeId, creditAccountId: accountId, kind: "fee", amountCents: 7_500, status: "settled", ref: "fee:j574:a" },
      { id: openDrawId, creditAccountId: accountId, kind: "invoice_draw", amountCents: 100_000, status: "posted", dueDate: new Date(Date.now() + 20 * 86400_000), ref: "draw:j574:b" },
    ]);
    const ledgerBefore = await world.db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.creditAccountId, accountId));

    // Reason is mandatory.
    let threw = false;
    try {
      await svc.adjustFeeBps(world.db as any, { accountId, newFeeBps: 250, reason: "  ", actorId: "j574" });
    } catch (e: any) { threw = e?.code === "BAD_REQUEST"; }
    assert(threw, "empty reason refused");

    const res = await svc.adjustFeeBps(world.db as any, {
      accountId, newFeeBps: 250, reason: "annual review", actorId: "j574-admin",
    });
    assert(res.ok && res.oldFeeBps === 150 && res.newFeeBps === 250 && res.unchanged === false, "fee re-pointed");

    const [acct] = await world.db.select().from(schema.creditAccounts)
      .where(eq(schema.creditAccounts.id, accountId));
    assert(acct.feeBps === 250, `fee_bps snapshot moved (got ${acct.feeBps})`);

    // Append-only: the three pre-existing rows are byte-identical; exactly
    // one new zero-amount 'adjustment' note row exists.
    const ledgerAfter = await world.db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.creditAccountId, accountId));
    assert(ledgerAfter.length === 4, `one adjustment row appended (got ${ledgerAfter.length})`);
    for (const before of ledgerBefore) {
      const after = ledgerAfter.find((r) => r.id === before.id)!;
      assert(JSON.stringify(after) === JSON.stringify(before), `ledger row ${before.id} (${before.kind}/${before.status}) untouched`);
    }
    const adj = ledgerAfter.find((r) => r.kind === "adjustment")!;
    assert(adj.amountCents === 0 && adj.note!.includes('"fee_bps_adjust"') && adj.note!.includes('"newFeeBps":250'), "adjustment note carries the audit payload");

    const audits = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, accountId));
    assert(audits.some((a) => a.action === "credit.fee_bps_adjusted"), "audit_logs entry written");

    // Idempotent no-op on the same value.
    const again = await svc.adjustFeeBps(world.db as any, {
      accountId, newFeeBps: 250, reason: "duplicate click", actorId: "j574-admin",
    });
    assert(again.unchanged === true, "same-value re-call is an honest no-op");
    const ledgerFinal = await world.db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.creditAccountId, accountId));
    assert(ledgerFinal.length === 4, "no-op appends nothing");

    // Closed account refuses.
    await world.db.update(schema.creditAccounts).set({ status: "closed" })
      .where(eq(schema.creditAccounts.id, accountId));
    threw = false;
    try {
      await svc.adjustFeeBps(world.db as any, { accountId, newFeeBps: 300, reason: "x", actorId: "j574" });
    } catch (e: any) { threw = e?.code === "BAD_REQUEST"; }
    assert(threw, "closed account refuses fee adjustment");
  },
};
// === END W56 credit ===
