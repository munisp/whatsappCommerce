// === W56 credit ===
/**
 * J576 — approvals threshold gate on large reschedules: with a tenant
 * policy covering kind "credit_servicing", an above-threshold reschedule
 * PARKS as pending_approval (plan untouched); owner approval executes the
 * SAME reschedule through the registered executor (schedule updated, audit
 * + ledger of the approval flow intact); a second approve hits the
 * single-consumption CONFLICT; below-threshold reschedules execute
 * directly with no approval row.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const DAY = 86400_000;
const TID = "j576-tenant";

export const journey: Journey = {
  id: "J576",
  name: "reschedule above threshold parks via credit_servicing approval; approve executes once",
  feature: "W56 credit servicing: W31 approvals gate composition",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    await world.db.insert(schema.tenants).values({ id: TID, name: "J576", slug: TID, status: "active" }).onConflictDoNothing();
    const [ownerUser] = await world.db.insert(schema.users).values({
      openId: "j576-owner", email: "j576-owner@sim.local", name: "J576 Owner",
      loginMethod: "keycloak", role: "user", tenantId: TID, phone: "+2348057600001", lastSignedIn: new Date(),
    }).returning();
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId: TID, userId: String(ownerUser.id), role: "owner" },
    ]).onConflictDoNothing();
    const owner = await tenantCaller(TID, { userId: ownerUser.id });

    const t0 = Date.now();
    const mkPlan = async (idSuffix: string, slices: Array<[number, number]>) => {
      const id = crypto.randomUUID();
      const total = slices.reduce((a, [p, f]) => a + p + f, 0);
      const principal = slices.reduce((a, [p]) => a + p, 0);
      await world.db.insert(schema.installmentPlans).values({
        id, tenantId: TID, vendorBillId: crypto.randomUUID(),
        principalCents: principal, installments: slices.length, feeBps: 0,
        perInstallmentCents: Math.floor(total / slices.length), status: "active",
        schedule: slices.map(([p, f], i) => ({
          seq: i + 1, dueAt: new Date(t0 + (i + 1) * 30 * DAY).toISOString(),
          amountCents: p + f, principalCents: p, feeCents: f,
          status: "due", paidAt: null,
        })),
      });
      return id;
    };

    // Policy: park credit_servicing actions ≥ ₦500.00.
    const pol = await owner.approvals.setPolicy({
      tenantId: TID, thresholdCents: 50_000, kinds: ["credit_servicing"], approverRole: "owner", expiryHours: 72,
    });
    assert(pol.ok === true && pol.enabled === true, "owner set the credit_servicing policy");

    // ── 1. Above-threshold reschedule PARKS ──────────────────────────────
    const bigPlan = await mkPlan("big", [[400_000, 4_000], [400_000, 4_000]]);
    const parked = await owner.creditServicing.reschedule({
      tenantId: TID, planId: bigPlan, graceDays: 21, reason: "big grace",
    });
    assert((parked as any).pendingApproval === true && typeof (parked as any).approvalId === "string", `parked (got ${JSON.stringify(parked).slice(0, 120)})`);
    const [planAfterPark] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, bigPlan));
    assert((planAfterPark.schedule as any[]).every((e) => !e.rescheduled), "parked reschedule leaves the schedule untouched");
    const [req] = await world.db.select().from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, (parked as any).approvalId));
    assert(req.kind === "credit_servicing" && req.status === "pending", "approval row parked with the new kind");
    assert((req.metadata as any)?.action === "reschedule_installments" && (req.metadata as any)?.graceDays === 21, "executor replay params stored on the row");

    // ── 2. Approve → executor replays the SAME reschedule ───────────────
    const before = (planAfterPark.schedule as any[]).map((e) => e.dueAt);
    const approved = await owner.approvals.approve({ tenantId: TID, approvalId: (parked as any).approvalId });
    assert(approved.ok === true && approved.executed === true, `approval executed (got ${JSON.stringify(approved).slice(0, 160)})`);
    const [planAfterApprove] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, bigPlan));
    const after = (planAfterApprove.schedule as any[]);
    assert(after.every((e) => e.rescheduled === true), "executor shifted every unpaid slice");
    for (const [i, e] of after.entries()) {
      assert(new Date(e.dueAt).getTime() - new Date(before[i]).getTime() === 21 * DAY, `slice ${e.seq} shifted +21d by the executor`);
    }

    // Second approve → single-consumption CONFLICT.
    let conflict = false;
    try {
      await owner.approvals.approve({ tenantId: TID, approvalId: (parked as any).approvalId });
    } catch (e: any) { conflict = e?.code === "CONFLICT" || /CONFLICT/.test(e?.message ?? ""); }
    assert(conflict, "second approve rejected (CONFLICT)");

    // ── 3. Below-threshold reschedule executes directly ──────────────────
    const smallPlan = await mkPlan("small", [[20_000, 200], [20_000, 200]]);
    const direct = await owner.creditServicing.reschedule({
      tenantId: TID, planId: smallPlan, graceDays: 7, reason: "small grace",
    });
    assert((direct as any).pendingApproval === false && (direct as any).ok === true, "below-threshold executes directly");
    const parkedCount = await world.db.select().from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.tenantId, TID));
    assert(parkedCount.length === 1, "no extra approval row for the small reschedule");

    // ── 4. Authz: another tenant cannot touch the plan ───────────────────
    let forbidden = false;
    try {
      await owner.creditServicing.reschedule({
        tenantId: "j191-tenant", planId: smallPlan, graceDays: 7, reason: "cross-tenant",
      });
    } catch (e: any) { forbidden = ["FORBIDDEN", "NOT_FOUND"].includes(e?.code); }
    assert(forbidden, "cross-tenant reschedule refused");
  },
};
// === END W56 credit ===
