// === W56 credit ===
/**
 * J577 — gracePeriod extends due_date on OPEN draws without voiding them,
 * dunning RESPECTS the extended dates (it reads due_date live from the
 * ledger — no cache): a draw that was 4 days overdue (late-fee milestone)
 * gets +10 days of grace → the next sweep applies NO late fee and NO freeze
 * markers; once the extended date itself lapses by 3 days the sweep applies
 * the milestone exactly once. Retrying the SAME grace action (same
 * actionRef) is claim-first idempotent — due dates move only once. Settled
 * draws are never extended.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const DAY = 86400_000;

export const journey: Journey = {
  id: "J577",
  name: "grace period extends open draws; dunning respects the extended due dates",
  feature: "W56 credit servicing: gracePeriod + dunning interplay, claim-first idempotency",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/creditServicing");
    const { runDunningCheckTx } = await import("../../server/services/tradeCredit/dunning");

    const sup = "j577-sup";
    const buy = "j577-buy";
    for (const [id, name] of [[sup, "J577 Supplier"], [buy, "J577 Buyer"]] as const) {
      await world.db.insert(schema.tenants).values({ id, name, slug: id, status: "active" }).onConflictDoNothing();
    }
    const accountId = crypto.randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId, supplierTenantId: sup, buyerTenantId: buy,
      limitCents: 10_000_000, outstandingCents: 300_000, termsDays: 14, status: "active",
    });
    const now = Date.now();
    // Open draw already 4d overdue (would hit the +3d late-fee milestone),
    // plus one settled draw that must never be extended.
    const openId = crypto.randomUUID();
    const settledId = crypto.randomUUID();
    await world.db.insert(schema.creditLedger).values([
      { id: openId, creditAccountId: accountId, kind: "invoice_draw", amountCents: 200_000, status: "posted", dueDate: new Date(now - 4 * DAY), ref: "draw:j577:a" },
      { id: settledId, creditAccountId: accountId, kind: "invoice_draw", amountCents: 100_000, status: "settled", dueDate: new Date(now - 4 * DAY), ref: "draw:j577:b" },
    ]);

    // ── 1. Grace +10d: open draw extended, settled draw untouched ────────
    const g = await svc.gracePeriod(world.db as any, {
      accountId, days: 10, reason: "logistics delay", actorId: "j577-admin", actionRef: "j577-grace-1",
    });
    assert(g.ok && g.extended === 1, `exactly the one open draw extended (got ${g.extended})`);
    let [open] = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, openId));
    const expectedDue = now - 4 * DAY + 10 * DAY;
    assert(Math.abs(new Date(open.dueDate!).getTime() - expectedDue) < 60_000, `due date moved +10d (got ${open.dueDate})`);
    assert(open.status === "posted" && open.note!.includes("[grace:j577-grace-1]"), "row extended in place — never voided, marker claimed");
    const [settled] = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, settledId));
    assert(Math.abs(new Date(settled.dueDate!).getTime() - (now - 4 * DAY)) < 60_000 && !(settled.note ?? "").includes("[grace:"), "settled draw untouched");
    const notes = (await world.db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.creditAccountId, accountId)))
      .filter((r) => r.kind === "adjustment");
    assert(notes.length === 1 && notes[0].note!.includes('"grace_period"'), "append-only adjustment note written");

    // ── 2. Claim-first idempotency: same actionRef extends nothing ───────
    const g2 = await svc.gracePeriod(world.db as any, {
      accountId, days: 10, reason: "logistics delay", actorId: "j577-admin", actionRef: "j577-grace-1",
    });
    assert(g2.extended === 0, "same actionRef is a no-op");
    [open] = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, openId));
    assert(Math.abs(new Date(open.dueDate!).getTime() - expectedDue) < 60_000, "due date did not move twice");

    // ── 3. Dunning respects the extended date (now due in 6 days) ────────
    const r1 = await runDunningCheckTx(world.db as any, new Date(now));
    [open] = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, openId));
    assert(!(open.note ?? "").includes("[dun:fee]"), `no late fee while inside grace (note=${open.note})`);
    assert(!(open.note ?? "").includes("[dun:"), "no dunning markers at all inside grace");
    const feesForDraw = r1.feesApplied; // other journeys' draws may exist in the world; assert via note above
    void feesForDraw;

    // ── 4. After the extended date lapses by 3d, the milestone fires once ─
    const pastExtended = new Date(expectedDue + 3 * DAY + 60_000);
    const r2 = await runDunningCheckTx(world.db as any, pastExtended);
    [open] = await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.id, openId));
    assert((open.note ?? "").includes("[dun:fee]"), "late fee lands after the EXTENDED date lapses");
    assert(r2.feesApplied >= 1, "sweep reports the fee");
    const feeRows = (await world.db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.creditAccountId, accountId)))
      .filter((r) => r.kind === "fee");
    assert(feeRows.length === 1, "exactly one late fee row");
    const r3 = await runDunningCheckTx(world.db as any, new Date(expectedDue + 4 * DAY));
    void r3;
    const feeRowsAfter = (await world.db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.creditAccountId, accountId)))
      .filter((r) => r.kind === "fee");
    assert(feeRowsAfter.length === 1, "re-sweep does not double-fee (dunning claim-first intact)");
  },
};
// === END W56 credit ===
