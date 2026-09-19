// === W47 stakeholders ===
/**
 * J450 — ONB-S-6/S-7 (journey level): capability/money gates against the
 * real DB. Once a tenant has ANY membership row the legacy users.tenantId
 * and memberships[] shortcuts no longer confer access; a tenant without
 * staff rows keeps the legacy path. (The lookup-error fail-closed branch
 * is covered by server/w47stakeholders.test.ts with a fault-injected db.)
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J450",
  name: "capability/money gates: legacy shortcut denied once staff rows exist",
  feature: "W47 stakeholders: ONB-S-6/S-7 fail-closed capability gates",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { assertCapabilityAccess } = await import("../../server/services/capabilities");
    const { assertMoneyAccess } = await import("../../server/_core/trpc");
    const { hasAnyMembership } = await import("../../server/services/membership");

    const T1 = "j450-staffed";
    const T2 = "j450-legacy";
    await world.db.insert(schema.tenants).values([
      { id: T1, name: "J450 Staffed", slug: T1, status: "active" },
      { id: T2, name: "J450 Legacy", slug: T2, status: "active" },
    ]).onConflictDoNothing();
    // T1 has a staff row for SOMEONE ELSE (user 4501).
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T1, userId: "4501", role: "owner",
    }).onConflictDoNothing();

    assert((await hasAnyMembership(T1)) === true, "T1 has membership rows");
    assert((await hasAnyMembership(T2)) === false, "T2 has none");

    // ── S-7: residual users.tenantId shortcut no longer passes on T1 ────
    const legacyUser = { id: 4502, role: "user", tenantId: T1, memberships: [T1] };
    let denied = false;
    try { await assertCapabilityAccess(legacyUser as any, T1, "finance"); } catch (e: any) {
      denied = true;
      assert(e?.code === "FORBIDDEN" && /membership/i.test(e.message), `denial cites membership (${e.message})`);
    }
    assert(denied, "capability gate denies the legacy shortcut on a staffed tenant");
    denied = false;
    try { await assertMoneyAccess(legacyUser as any, T1); } catch (e: any) {
      denied = true;
      assert(e?.code === "FORBIDDEN", "money gate FORBIDDEN");
    }
    assert(denied, "money gate denies the legacy shortcut on a staffed tenant");

    // ── Legacy single-user tenant (no staff rows) still passes ──────────
    await assertCapabilityAccess({ id: 4503, role: "user", tenantId: T2 } as any, T2, "catalog");
    await assertMoneyAccess({ id: 4503, role: "user", tenantId: T2 } as any, T2);

    // ── A scoped member is authoritative on T1 (finance ≠ catalog) ──────
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T1, userId: "4504", role: "finance",
    }).onConflictDoNothing();
    const fin = { id: 4504, role: "user", tenantId: null };
    await assertCapabilityAccess(fin as any, T1, "finance");
    denied = false;
    try { await assertCapabilityAccess(fin as any, T1, "catalog"); } catch (e: any) { denied = e?.code === "FORBIDDEN"; }
    assert(denied, "finance-scoped member denied catalog");
    await assertMoneyAccess(fin as any, T1); // finance admitted to money
  },
};
