// === W54 capabilities (CAP-1) ===
/**
 * J553 — Membership plans router: create (integer-cents price, validated
 * benefits) → update → list → roster → archive (claim-first CONFLICT on
 * replay). Authz: unauthenticated UNAUTHORIZED, cross-tenant FORBIDDEN —
 * every procedure is tenant-guarded (protectedProcedure +
 * assertTenantAccess; price-bearing mutations also assertMoneyAccess).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, expectTrpcError } from "./helpers";

export const journey: Journey = {
  id: "J553",
  name: "membership plans router: create/update/list/roster/archive + authz",
  feature: "W54 capabilities: consumer membership tiers admin CRUD",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const userId = 5461;
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TENANT_ID, userId: String(userId), role: "owner",
    }).onConflictDoNothing();

    const caller = await tenantCaller(TENANT_ID, { userId });

    // ── CRUD ────────────────────────────────────────────────────────────
    const gold = await caller.membershipPlans.createPlan({
      tenantId: TENANT_ID,
      name: "W54 Gold",
      description: "10% off + 2x points",
      priceCents: 0, // free tier
      period: "month",
      discountPercent: 10,
      pointsMultiplier: 2,
    });
    assert(gold.id && gold.status === "active", `plan created active (got ${gold.status})`);
    assert(gold.priceCents === 0 && gold.discountPercent === 10 && gold.pointsMultiplier === 2,
      "integer cents price + benefits persisted");

    const updated = await caller.membershipPlans.updatePlan({
      tenantId: TENANT_ID, planId: gold.id, discountPercent: 15,
    });
    assert(updated.discountPercent === 15, "update applies (discount 10 → 15)");

    const listed = await caller.membershipPlans.listPlans({ tenantId: TENANT_ID });
    assert(listed.some((p: any) => p.id === gold.id), "list shows the plan");

    // Validation guards (money truth: integer cents, sane benefit ranges).
    await expectTrpcError(
      caller.membershipPlans.createPlan({ tenantId: TENANT_ID, name: "Bad", priceCents: -5, period: "month", discountPercent: 10 }),
      "BAD_REQUEST", "negative price rejected",
    );
    await expectTrpcError(
      caller.membershipPlans.createPlan({ tenantId: TENANT_ID, name: "NoBenefit", priceCents: 0, period: "month" }),
      "BAD_REQUEST", "benefit-less plan rejected",
    );

    // Roster: a member joined via the service shows up with the plan name.
    const { joinMembership } = await import("../../server/services/membershipPlans");
    await joinMembership(world.db as any, { tenantId: TENANT_ID, planId: gold.id, customerRef: world.newPhone("546") });
    const roster = await caller.membershipPlans.roster({ tenantId: TENANT_ID, planId: gold.id });
    assert(roster.length === 1 && roster[0].planName === "W54 Gold" && roster[0].status === "active",
      `roster carries the joined member (got ${JSON.stringify(roster).slice(0, 120)})`);

    // Archive: claim-first — replay is an honest CONFLICT; archived plans
    // drop out of the default list.
    const archived = await caller.membershipPlans.archivePlan({ tenantId: TENANT_ID, planId: gold.id });
    assert(archived.status === "archived", "plan archived");
    await expectTrpcError(
      caller.membershipPlans.archivePlan({ tenantId: TENANT_ID, planId: gold.id }),
      "CONFLICT", "re-archive",
    );
    const listedAfter = await caller.membershipPlans.listPlans({ tenantId: TENANT_ID });
    assert(!listedAfter.some((p: any) => p.id === gold.id), "archived plan hidden from the active list");

    // ── Authz ───────────────────────────────────────────────────────────
    const { appRouter } = await import("../../server/routers");
    const anon = appRouter.createCaller({ user: null } as any);
    await expectTrpcError(
      anon.membershipPlans.listPlans({ tenantId: TENANT_ID }),
      "UNAUTHORIZED", "anonymous caller rejected",
    );
    const cross = await tenantCaller("tenant-other-w54", { userId: 5469 });
    await expectTrpcError(
      cross.membershipPlans.listPlans({ tenantId: TENANT_ID }),
      "FORBIDDEN", "cross-tenant read rejected",
    );
    await expectTrpcError(
      cross.membershipPlans.createPlan({ tenantId: TENANT_ID, name: "Intrusion", priceCents: 100, period: "month", discountPercent: 5 }),
      "FORBIDDEN", "cross-tenant create rejected",
    );
  },
};
// === END W54 capabilities ===
