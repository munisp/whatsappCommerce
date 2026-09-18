// === W46 kyc (Coder A) ===
/**
 * J390 — TEN-10 + TEN-12.
 *  TEN-10: membership.remove kills access for real — clears the legacy
 *    users.tenantId shortcut, revokes ALL sessions (revoke-all marker),
 *    and busts the 60s membership cache.
 *  TEN-12: erasure is blocked while the subject is the SOLE OWNER of an
 *    ACTIVE tenant; after ownership transfer (second owner added),
 *    erasure completes.
 */
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J390",
  name: "removeMember kills sessions/cache; sole-owner erasure blocked",
  feature: "TEN-10 session/cache kill + TEN-12 sole-owner erasure guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const sdk = await import("../../server/_core/sdk");
    const admin = await adminCaller();

    // ── TEN-10 ─────────────────────────────────────────────────────────
    const tenantId = `j390-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.tenants).values({
      id: tenantId, name: "J390 Removal Store", slug: tenantId, status: "active",
    }).onConflictDoNothing();
    const [op] = await world.db.insert(schema.users).values({
      openId: `j390-op-${randomUUID().slice(0, 8)}`, email: "j390-op@sim.local", name: "J390 Op",
      loginMethod: "keycloak", role: "user", tenantId, lastSignedIn: new Date(),
    }).returning();
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId, userId: "j390-owner", role: "owner" },
      { tenantId, userId: String(op.id), role: "operator" },
    ]).onConflictDoNothing();

    // Prime the membership cache so we can prove it gets busted.
    const primed = await sdk.getUserMembershipTenantIds(op.id);
    assert(primed.includes(tenantId), "membership cache primed");

    const res = await admin.membership.remove({ tenantId, userId: op.id });
    assert(res.removed === true, "member removed");

    const remaining = await world.db.select().from(schema.tenantMemberships)
      .where(and(eq(schema.tenantMemberships.tenantId, tenantId), eq(schema.tenantMemberships.userId, String(op.id))));
    assert(remaining.length === 0, "membership row deleted");
    const [opRow] = await world.db.select().from(schema.users).where(eq(schema.users.id, op.id));
    assert(opRow.tenantId === null, "TEN-10: users.tenantId legacy shortcut cleared");
    const revs = await world.db.select().from(schema.sessionRevocations)
      .where(eq(schema.sessionRevocations.jti, sdk.userRevocationMarkerJti(op.id)));
    assert(revs.length === 1, "TEN-10: revoke-all sessions marker written");
    const afterBust = await sdk.getUserMembershipTenantIds(op.id);
    assert(!afterBust.includes(tenantId), "TEN-10: membership cache busted (no 60s linger)");
    assert(await sdk.isSessionRevoked({ userId: op.id }), "TEN-10: sessions reported revoked");

    // ── TEN-12 ─────────────────────────────────────────────────────────
    const tenant2 = `j390b-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.tenants).values({
      id: tenant2, name: "J390 Erasure Store", slug: tenant2, status: "active",
    }).onConflictDoNothing();
    const [owner] = await world.db.insert(schema.users).values({
      openId: `j390-own-${randomUUID().slice(0, 8)}`, email: "j390-own@sim.local", name: "J390 Sole Owner",
      loginMethod: "keycloak", role: "user", tenantId: tenant2, lastSignedIn: new Date(),
    }).returning();
    await world.db.insert(schema.tenantMemberships).values(
      { tenantId: tenant2, userId: String(owner.id), role: "owner" },
    ).onConflictDoNothing();
    const { appRouter } = await import("../../server/routers");
    const mkCaller = (u: any) => appRouter.createCaller({
      user: { id: u.id, openId: u.openId, email: u.email, name: u.name, loginMethod: "keycloak", role: "user", tenantId: u.tenantId, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} },
    } as any);

    const blocked = await mkCaller(owner).privacy.requestErasure({ reason: "J390 sole owner" });
    assert(blocked.status === "blocked" && (blocked as any).reason === "sole_owner_active_tenant",
      `TEN-12: sole owner of active tenant blocked (got ${JSON.stringify(blocked)})`);
    const [stillThere] = await world.db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    assert(stillThere.email === "j390-own@sim.local", "PII untouched while blocked");

    // Transfer ownership (second owner) → erasure completes.
    await world.db.insert(schema.tenantMemberships).values(
      { tenantId: tenant2, userId: "j390-second-owner", role: "owner" },
    ).onConflictDoNothing();
    const done = await mkCaller(owner).privacy.requestErasure({ reason: "J390 after transfer" });
    assert(done.status === "completed", `TEN-12: erasure completes after ownership transfer (got ${JSON.stringify(done)})`);
  },
};
// === END W46 kyc ===
