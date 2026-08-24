/**
 * J165 — W30 (verify-v1 #5): mandate double-submit charges exactly once.
 *
 * Two CONCURRENT identical repayments against the seeded facility's active
 * mandate: the deterministic repayment reference (sha256 of
 * mandate|amount|outstanding) plus the unique per-account pending marker
 * (claim-first) make the loser collide and return the truthful 'duplicate'
 * verdict — the provider sees exactly ONE charge_authorization call,
 * exactly one repayment ledger row lands, and outstanding moves exactly
 * once.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World, CREDIT_ACCOUNT_ID, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { linkActiveMandate } from "./helpers";

const chargeAuthCalls = (world: World) =>
  world.outbound.all().filter((c) => c.url.includes("api.paystack.co/transaction/charge_authorization"));

export const journey: Journey = {
  id: "J165",
  name: "mandate double-submit → single charge",
  feature: "tradeCredit capture exactly-once (verify-v1 #5)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const tc = await import("../../server/services/tradeCredit");

    // Seed ₦10,000 outstanding on the seeded facility via the real draw path.
    const draw = await tc.drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 1_000_000,
      poId: "po-j165-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");
    await linkActiveMandate(world, { buyerTenantId: TENANT_ID, accountId: CREDIT_ACCOUNT_ID, userId: 165 });

    const chargesBefore = chargeAuthCalls(world).length;

    // ── Concurrent identical repayments → one charge ───────────────────
    const [a, b] = await Promise.all([
      tc.requestRepayment({ accountId: CREDIT_ACCOUNT_ID, amountCents: 400_000 }),
      tc.requestRepayment({ accountId: CREDIT_ACCOUNT_ID, amountCents: 400_000 }),
    ]);
    const outcomes = [a, b];
    const successes = outcomes.filter((r) => r.ok && r.mode === "mandate");
    const dups = outcomes.filter((r) => !r.ok && r.reason === "duplicate");
    assert(successes.length === 1, `exactly one mandate repayment succeeds (${JSON.stringify(outcomes).slice(0, 400)})`);
    assert(dups.length === 1, "the loser gets the truthful duplicate verdict");

    const charges = chargeAuthCalls(world).slice(chargesBefore);
    assert(charges.length === 1, `exactly ONE provider charge (got ${charges.length})`);
    assert(charges[0].body?.reference === (successes[0] as any).reference, "charge carries the deterministic reference");
    assert(
      new RegExp(`^cr-${CREDIT_ACCOUNT_ID}-\\d{8}-[0-9a-f]{12}$`).test((successes[0] as any).reference),
      "deterministic reference shape",
    );

    // Outstanding moved exactly once; exactly one repayment ledger row.
    const [acctAfter] = await world.db
      .select()
      .from(schema.creditAccounts)
      .where(eq(schema.creditAccounts.id, CREDIT_ACCOUNT_ID))
      .limit(1);
    assert(acctAfter.outstandingCents === 600_000, `outstanding drops once (got ${acctAfter.outstandingCents})`);
    const repayRows = (await world.db
      .select()
      .from(schema.creditLedger)
      .where(and(eq(schema.creditLedger.creditAccountId, CREDIT_ACCOUNT_ID), eq(schema.creditLedger.kind, "repayment"))));
    assert(repayRows.length === 1 && repayRows[0].amountCents === 400_000, "exactly one repayment ledger row");

    // No pending marker is stranded after a terminal success.
    const markers = (await world.db
      .select()
      .from(schema.processedWebhookEvents)
      .where(eq(schema.processedWebhookEvents.type, "credit_repayment_pending")));
    assert(!markers.some((m: any) => m.id === `crp:${CREDIT_ACCOUNT_ID}`), "pending marker released after settlement");

    // A follow-up repayment (new deterministic ref — the outstanding marker
    // moved) settles normally through the same path.
    const again = await tc.requestRepayment({ accountId: CREDIT_ACCOUNT_ID, amountCents: 600_000 });
    assert(again.ok === true && again.mode === "mandate", "follow-up repayment settles normally");
    const [acctDone] = await world.db
      .select()
      .from(schema.creditAccounts)
      .where(eq(schema.creditAccounts.id, CREDIT_ACCOUNT_ID))
      .limit(1);
    assert(acctDone.outstandingCents === 0, "facility fully repaid");
  },
};
