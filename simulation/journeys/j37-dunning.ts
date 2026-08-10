/**
 * J37 — Dunning reminders + late fee: an invoice_draw swept at its -3d
 * window start sends the buyer's admin a credit-reminder template (the 24h
 * session window is closed); re-sweeping the same milestone is a no-op
 * (marker idempotency); at +3d overdue a 2% late fee is posted ONCE.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { ADMIN_PHONE, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { creditLedgerRows } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J37",
  name: "dunning reminders + late fee",
  feature: "runDunningCheck milestones, idempotent markers",
  async run(world) {
    const { drawOnCredit, runDunningCheck } = await import("../../server/services/tradeCredit");

    // ₦200,000 draw; due date manipulated to 2 days from now (the -3d window).
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 20_000_000,
      poId: "po-j37-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");
    const drawId = draw.ledgerId;
    const t0 = new Date();
    const dueAt = new Date(t0.getTime() + 2 * DAY_MS);
    await world.backdate(`UPDATE credit_ledger SET due_date = $1 WHERE id = $2`, [dueAt, drawId]);

    const reminderCount = () =>
      world.outbound.ofType("template", ADMIN_PHONE).filter((c) => bodyText(c) === "template:credit_due_reminder").length;

    // ── Sweep 1: -3d window → ONE reminder (template, window closed) ─────
    const r1 = await runDunningCheck(t0);
    assert(r1.reminded === 1 && r1.feesApplied === 0 && r1.frozen === 0, `sweep 1: {${r1.reminded},${r1.feesApplied},${r1.frozen}}`);
    await world.settle(300);
    assert(reminderCount() === 1, "one reminder template sent");
    const reminder = world.outbound.ofType("template", ADMIN_PHONE).pop();
    const reminderSerialized = JSON.stringify(reminder?.body ?? {});
    assertIncludes(reminderSerialized, "credit_due_reminder", "reminder uses the credit template");
    assertIncludes(reminderSerialized, "₦200k", "reminder carries the draw amount");
    assertIncludes(reminderSerialized, dueAt.toISOString().slice(0, 10), "reminder carries the due date");

    // ── Sweep 2 (same milestone): marker claimed → NO duplicate ──────────
    const r2 = await runDunningCheck(t0);
    assert(r2.reminded === 0 && r2.feesApplied === 0 && r2.frozen === 0, `sweep 2 idempotent: {${r2.reminded},${r2.feesApplied},${r2.frozen}}`);
    await world.settle(300);
    assert(reminderCount() === 1, "no duplicate reminder on re-sweep");

    // ── Sweep 3 at +3d overdue: 2% late fee ONCE + second reminder ────────
    const t3 = new Date(t0.getTime() + 5 * DAY_MS); // due was t0+2d → offset +3
    const r3 = await runDunningCheck(t3);
    assert(r3.reminded === 1 && r3.feesApplied === 1 && r3.frozen === 0, `sweep 3: {${r3.reminded},${r3.feesApplied},${r3.frozen}}`);
    await world.settle(300);
    assert(reminderCount() === 2, "second reminder at the +3d milestone");

    const fees = await creditLedgerRows(world, "fee");
    assert(fees.length === 1, `one late-fee ledger row (got ${fees.length})`);
    assert(Number(fees[0].amountCents) === 400_000, `fee = 2% of ₦200,000 (got ${fees[0].amountCents})`);
    assert(fees[0].ref === `latefee:${drawId}`, "fee ref keys on the draw id");

    // ── Sweep 4 (same +3d milestone): NO second fee, NO third reminder ────
    const r4 = await runDunningCheck(t3);
    assert(r4.reminded === 0 && r4.feesApplied === 0 && r4.frozen === 0, `sweep 4 idempotent: {${r4.reminded},${r4.feesApplied},${r4.frozen}}`);
    await world.settle(300);
    assert((await creditLedgerRows(world, "fee")).length === 1, "late fee applied exactly once");
    assert(reminderCount() === 2, "no duplicate +3d reminder");
  },
};
