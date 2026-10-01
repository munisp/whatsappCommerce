// === W56 credit ===
/**
 * J575 — rescheduleInstallments math: the principal SUM INVARIANT holds
 * exactly (integer cents, remainder on the last slice — no rounding loss),
 * the fee delta is explicit, paid slices are byte-preserved, replacement
 * slices are stamped rescheduled:true with their previous dueAt/amount, and
 * the prior unpaid schedule survives in the audit-log before-payload.
 * Also: principal drift is REFUSED, non-active plans refuse, and the
 * graceDays mode shifts unpaid due dates without touching amounts.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const DAY = 86400_000;

/** Key-order-insensitive stringify (jsonb round-trips reorder keys). */
function canon(x: unknown): string {
  return JSON.stringify(x, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v);
}

export const journey: Journey = {
  id: "J575",
  name: "installment reschedule: principal sum invariant + explicit fee delta + audit",
  feature: "W56 credit servicing: reschedule math",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/creditServicing");

    const tid = "j575-tenant";
    await world.db.insert(schema.tenants).values({ id: tid, name: "J575", slug: tid, status: "active" }).onConflictDoNothing();

    // Plan: ₦1,000.00 principal + 3 slices; slice 1 already PAID.
    const t0 = Date.now();
    const mk = (seq: number, principalCents: number, feeCents: number, status: "paid" | "due", dueAt: number) => ({
      seq,
      dueAt: new Date(dueAt).toISOString(),
      amountCents: principalCents + feeCents,
      principalCents,
      feeCents,
      status,
      paidAt: status === "paid" ? new Date(dueAt - DAY).toISOString() : null,
    });
    const planId = crypto.randomUUID();
    const schedule = [
      mk(1, 33_333, 334, "paid", t0 - 30 * DAY),
      mk(2, 33_333, 333, "due", t0 + 5 * DAY),
      mk(3, 33_334, 333, "due", t0 + 35 * DAY),
    ];
    await world.db.insert(schema.installmentPlans).values({
      id: planId, tenantId: tid, vendorBillId: crypto.randomUUID(),
      principalCents: 100_000, installments: 3, feeBps: 100,
      perInstallmentCents: 33_667, status: "active", schedule,
    });

    // ── 1. Principal drift is refused, plan untouched ────────────────────
    let threw = false;
    try {
      await svc.rescheduleInstallments(world.db as any, {
        planId, reason: "drift attempt", actorId: "j575",
        newSchedule: [{ dueAt: new Date(t0 + 60 * DAY).toISOString(), principalCents: 66_668, feeCents: 0 }],
      });
    } catch (e: any) { threw = /principal sum invariant/.test(e?.message); }
    assert(threw, "principal drift refused");
    let [plan] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, planId));
    assert(canon(plan.schedule) === canon(schedule), "refused reschedule leaves the plan untouched");

    // ── 2. Re-slice 2 unpaid → 3 slices, fee delta explicit ─────────────
    const remainingPrincipal = 66_667; // 33_333 + 33_334
    const per = Math.floor(remainingPrincipal / 3);
    const res = await svc.rescheduleInstallments(world.db as any, {
      planId, reason: "buyer cash-flow", actorId: "j575-admin",
      newSchedule: [
        { dueAt: new Date(t0 + 30 * DAY).toISOString(), principalCents: per, feeCents: 200 },
        { dueAt: new Date(t0 + 60 * DAY).toISOString(), principalCents: per, feeCents: 200 },
        { dueAt: new Date(t0 + 90 * DAY).toISOString(), principalCents: remainingPrincipal - 2 * per, feeCents: 200 },
      ],
    });
    assert(res.ok && res.mode === "schedule" && res.rescheduledCount === 2, "rescheduled");
    assert(res.principalDeltaCents === 0, "principal delta is exactly 0");
    assert(res.feeDeltaCents === 600 - 666, `fee delta explicit (got ${res.feeDeltaCents})`);
    const newUnpaid = res.schedule.filter((e) => e.status !== "paid");
    assert(newUnpaid.reduce((a, e) => a + e.principalCents, 0) === remainingPrincipal, "sum invariant on the persisted schedule");
    assert(newUnpaid.every((e) => Number.isInteger(e.amountCents) && Number.isInteger(e.principalCents) && Number.isInteger(e.feeCents)), "integer cents everywhere");
    assert(newUnpaid.every((e) => e.rescheduled === true), "replacement slices stamped rescheduled");
    assert(newUnpaid[0].previousDueAt === schedule[1].dueAt && newUnpaid[0].previousAmountCents === schedule[1].amountCents, "previous dueAt/amount preserved on the slice");
    assert(newUnpaid.map((e) => e.seq).join(",") === "2,3,4", "seq continues after paid slices");

    // Paid slice byte-preserved.
    [plan] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, planId));
    const persisted = (plan.schedule as any[]);
    assert(canon(persisted.find((e) => e.seq === 1)) === canon(schedule[0]), "paid slice byte-preserved");

    // Prior unpaid schedule survives in the audit trail.
    const audits = await world.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, planId));
    const audit = audits.find((a) => a.action === "credit.installments_rescheduled");
    assert(audit, "reschedule audit row written");
    assert(canon((audit!.before as any)?.unpaidSchedule) === canon(schedule.slice(1)), "prior unpaid schedule preserved in audit before-payload");
    assert((audit!.after as any)?.feeDeltaCents === res.feeDeltaCents, "fee delta explicit in the audit after-payload");

    // ── 3. graceDays mode shifts due dates, amounts untouched ───────────
    const before = (plan.schedule as any[]).filter((e) => e.status !== "paid").map((e) => ({ dueAt: e.dueAt, amountCents: e.amountCents }));
    const g = await svc.rescheduleInstallments(world.db as any, {
      planId, graceDays: 14, reason: "holiday shift", actorId: "j575-admin",
    });
    assert(g.mode === "grace" && g.feeDeltaCents === 0, "grace mode has zero fee delta");
    const after = g.schedule.filter((e) => e.status !== "paid");
    for (const [i, e] of after.entries()) {
      assert(new Date(e.dueAt).getTime() - new Date(before[i].dueAt).getTime() === 14 * DAY, `slice ${e.seq} shifted +14d`);
      assert(e.amountCents === before[i].amountCents, `slice ${e.seq} amount untouched`);
      assert(e.rescheduled === true && e.previousDueAt === before[i].dueAt, `slice ${e.seq} stamped with previous dueAt`);
    }

    // ── 4. Non-active plans refuse ───────────────────────────────────────
    await world.db.update(schema.installmentPlans).set({ status: "repaid" }).where(eq(schema.installmentPlans.id, planId));
    threw = false;
    try {
      await svc.rescheduleInstallments(world.db as any, { planId, graceDays: 7, reason: "x", actorId: "j575" });
    } catch (e: any) { threw = e?.code === "BAD_REQUEST"; }
    assert(threw, "non-active plan refuses reschedule");
  },
};
// === END W56 credit ===
