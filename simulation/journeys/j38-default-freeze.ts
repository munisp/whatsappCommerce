/**
 * J38 — Default freeze: an invoice_draw 8 days past due → the dunning sweep
 * freezes the credit account (claim-first active → frozen), notifies the
 * buyer's admin, and any new drawOnCredit attempt is refused with
 * { ok: false, reason: 'frozen' }.
 */
import { assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { ADMIN_PHONE, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { creditAccount } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J38",
  name: "default freeze",
  feature: "dunning +7d → account frozen, new draws refused",
  async run(world) {
    const { drawOnCredit, runDunningCheck } = await import("../../server/services/tradeCredit");

    // ₦50,000 draw due 8 days ago (past the +7d freeze threshold).
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 5_000_000,
      poId: "po-j38-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");
    const t0 = new Date();
    await world.backdate(`UPDATE credit_ledger SET due_date = $1 WHERE id = $2`, [new Date(t0.getTime() - 8 * DAY_MS), draw.ledgerId]);

    // ── Sweep freezes the facility ────────────────────────────────────────
    const sweep = await runDunningCheck(t0);
    assert(sweep.frozen === 1, `sweep froze one account (got ${sweep.frozen})`);
    assert(sweep.reminded === 1, "freeze reminder sent");

    const account = await creditAccount(world);
    assert(account.status === "frozen", `account frozen (got ${account.status})`);

    // ── Buyer admin notified (template — 24h window closed) ───────────────
    await world.settle(300);
    const notice = world.outbound.ofType("template", ADMIN_PHONE).filter((c) => bodyText(c) === "template:credit_due_reminder");
    assert(notice.length === 1, "buyer admin received the freeze reminder");

    // ── New draws refused with reason 'frozen' ────────────────────────────
    const attempt = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 1_000_000,
      poId: "po-j38-blocked",
      termsDays: 14,
    });
    assert(attempt.ok === false && attempt.reason === "frozen", `draw refused as frozen (got ${JSON.stringify(attempt)})`);

    // Outstanding untouched by the refused draw; account stays frozen. Since
    // assurance Fix 4 (A1-08b) the late fee is collectible: outstanding_cents
    // now includes the ₦1,000 late fee posted by the +7d sweep.
    const after = await creditAccount(world);
    assert(Number(after.outstandingCents) === 5_100_000, `outstanding = draw + late fee (got ${after.outstandingCents})`);
    assert(after.status === "frozen", "still frozen after the refused draw");
    const { creditLedgerRows } = await import("./helpers");
    const fees = await creditLedgerRows(world, "fee");
    assert(fees.length === 1 && Number(fees[0].amountCents) === 100_000, "2% late fee posted once");

    // ── A second sweep does not re-freeze or re-notify ────────────────────
    const sweep2 = await runDunningCheck(t0);
    assert(sweep2.frozen === 0 && sweep2.reminded === 0, `second sweep quiet (got ${JSON.stringify(sweep2)})`);
  },
};
