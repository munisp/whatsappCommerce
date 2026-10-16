// === W54 capabilities (CAP-1) ===
/**
 * J557 — Membership cancel semantics: a PAID tier cancels at period end
 * (cancelAtPeriodEnd — benefits keep applying until currentPeriodEnd, then
 * the expiry sweep flips active → expired and benefits stop); a FREE tier
 * cancels immediately. Claim-first: a second cancel reports "none".
 * Read-side guard: a past period end never grants benefits even before the
 * sweep runs (fail-closed money).
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J557",
  name: "membership cancel at period end + expiry sweep + read-side expiry guard",
  feature: "W54 capabilities: membership cancel semantics",
  async run(world: World) {
    const svc = await import("../../server/services/membershipPlans");
    const phone = world.newPhone("550");
    await world.grantConsent(phone);

    // ── 1. Paid membership with a period end (joined via activation seam) ─
    const plan = await svc.createMembershipPlan(world.db as any, {
      tenantId: TENANT_ID, name: "J557 Gold", priceCents: 100_000, period: "month",
      discountPercent: 10, pointsMultiplier: 1,
    });
    const joined = await svc.joinMembership(world.db as any, { tenantId: TENANT_ID, planId: plan.id, customerRef: phone });
    assert(joined.kind === "payment_link", "paid tier needs payment");
    const act = await svc.activateMembershipForOrder(world.db as any, joined.orderId!, "SIM-REF-550");
    assert(act.activated && act.membership, "activation seam activates");

    // Benefits apply while active.
    const before = await svc.memberBenefitsFor(world.db as any, TENANT_ID, phone);
    assert(before?.discountPercent === 10, "benefits live while active");

    // ── 2. Cancel → period end (subscription semantics) ──────────────────
    const cancel = await svc.cancelMembership(world.db as any, { tenantId: TENANT_ID, customerRef: phone });
    assert(cancel.cancelled === "period_end" && cancel.currentPeriodEnd instanceof Date,
      `paid tier cancels at period end (got ${cancel.cancelled})`);
    // Benefits KEEP applying until the period ends.
    const during = await svc.memberBenefitsFor(world.db as any, TENANT_ID, phone);
    assert(during?.discountPercent === 10, "benefits run to period end");
    // Second cancel is an honest no-op (row already flagged).
    const again = await svc.cancelMembership(world.db as any, { tenantId: TENANT_ID, customerRef: phone });
    assert(again.cancelled === "period_end", "re-cancel stays idempotent (still period_end)");

    // ── 3. Read-side expiry guard: past period end → no benefits ────────
    const past = new Date(Date.now() + 40 * 86_400_000); // beyond the 1-month period
    const afterEnd = await svc.memberBenefitsFor(world.db as any, TENANT_ID, phone, past);
    assert(afterEnd === null, "no benefits after period end (read-side guard)");

    // ── 4. Expiry sweep flips active → expired; benefits stop ───────────
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    await world.db.update(schema.customerMemberships)
      .set({ currentPeriodEnd: new Date(Date.now() - 1000) })
      .where(eq(schema.customerMemberships.id, act.membership!.id));
    const sweep = await svc.runMembershipExpirySweep(world.db as any);
    assert(sweep.expired >= 1, `sweep expired the row (got ${JSON.stringify(sweep)})`);
    const post = await svc.memberBenefitsFor(world.db as any, TENANT_ID, phone);
    assert(post === null, "no benefits after expiry");
    const status = await svc.getMembershipStatus(world.db as any, TENANT_ID, phone);
    assert(status === null, "status query skips expired rows");

    // ── 5. Free tier cancels immediately ─────────────────────────────────
    const freePlan = await svc.createMembershipPlan(world.db as any, {
      tenantId: TENANT_ID, name: "J557 Free", priceCents: 0, period: "month",
      discountPercent: 5, pointsMultiplier: 1,
    });
    const phone2 = world.newPhone("550b");
    const free = await svc.joinMembership(world.db as any, { tenantId: TENANT_ID, planId: freePlan.id, customerRef: phone2 });
    assert(free.kind === "active", "free tier activates immediately");
    const freeCancel = await svc.cancelMembership(world.db as any, { tenantId: TENANT_ID, customerRef: phone2 });
    assert(freeCancel.cancelled === "immediate", `free tier cancels immediately (got ${freeCancel.cancelled})`);
    const freePost = await svc.memberBenefitsFor(world.db as any, TENANT_ID, phone2);
    assert(freePost === null, "free-tier benefits stop at once");
    // Cancelling with no membership reports none.
    const none = await svc.cancelMembership(world.db as any, { tenantId: TENANT_ID, customerRef: phone2 });
    assert(none.cancelled === "none", "second cancel reports none");

    // ── 6. One live membership per customer (claim-first) ────────────────
    await svc.joinMembership(world.db as any, { tenantId: TENANT_ID, planId: freePlan.id, customerRef: phone2 });
    let conflict = false;
    try {
      await svc.joinMembership(world.db as any, { tenantId: TENANT_ID, planId: freePlan.id, customerRef: phone2 });
    } catch (e: any) {
      conflict = e?.code === "CONFLICT";
    }
    assert(conflict, "duplicate live join is a CONFLICT");
  },
};
// === END W54 capabilities ===
