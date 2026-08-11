/**
 * J60 — Sessions + memberships + tenant types (W12 tenancy cross-cut).
 *
 *  Memberships: an operator member WITHOUT users.tenantId passes
 *    assertTenantAccess via the membership fallback (both directly and
 *    through the real sdk.authenticateRequest → memberships snapshot); a
 *    non-member 403s; the last owner cannot be removed.
 *  Sessions: issued tokens carry a 12h default TTL; logout revokes the jti
 *    so the SAME token is rejected; the admin revoke-all marker rejects
 *    every session of the user. session_revocations rows asserted in DB.
 *  Tenant types: tenantType defaults 'retailer'; applying the 0049 backfill
 *    SQL flips the supplier-profile tenant to 'hybrid'.
 */
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { ENV } from "../../server/_core/env";
import { SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J60",
  name: "sessions + memberships + tenant types",
  feature: "W12 tenancy hardening cross-cut",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    // ── Staff users: an owner and an operator (NO users.tenantId) ─────────
    const [owner] = await world.db.insert(schema.users).values({
      openId: "w12-staff-owner", email: "owner@sim.local", name: "Staff Owner",
      loginMethod: "keycloak", role: "user", tenantId: null, lastSignedIn: new Date(),
    }).returning();
    const [operator] = await world.db.insert(schema.users).values({
      openId: "w12-staff-op", email: "op@sim.local", name: "Staff Operator",
      loginMethod: "keycloak", role: "user", tenantId: null, lastSignedIn: new Date(),
    }).returning();
    const [outsider] = await world.db.insert(schema.users).values({
      openId: "w12-outsider", email: "outsider@sim.local", name: "Outsider",
      loginMethod: "keycloak", role: "user", tenantId: null, lastSignedIn: new Date(),
    }).returning();

    const m1 = await admin.membership.add({ tenantId: TENANT_ID, userId: owner.id });
    assert(m1.role === "owner", `first member forced to owner (got ${m1.role})`);
    const m2 = await admin.membership.add({ tenantId: TENANT_ID, userId: operator.id, role: "operator" });
    assert(m2.role === "operator", "second member added as operator");

    // ── Membership fallback in assertTenantAccess (direct) ────────────────
    const { appRouter } = await import("../../server/routers");
    const mkCtx = (user: any) => ({
      user,
      req: { protocol: "http", headers: {} },
      res: { clearCookie: () => {} },
    }) as any;
    const memberCtxCaller = appRouter.createCaller(mkCtx({
      id: operator.id, openId: operator.openId, role: "user", tenantId: null,
      memberships: [TENANT_ID], name: operator.name, email: operator.email,
      loginMethod: "keycloak", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    }));
    const stock = await memberCtxCaller.inventory.getStockLevels({ tenantId: TENANT_ID });
    assert(Array.isArray(stock) && stock.length > 0, "operator passes assertTenantAccess via membership fallback (no users.tenantId)");
    await expectTrpcError(
      memberCtxCaller.inventory.getStockLevels({ tenantId: SUPPLIER_TENANT_ID }),
      "FORBIDDEN",
      "operator denied for a tenant they are NOT a member of",
    );

    // ── operatorProcedure: membership role checked from the DB ────────────
    const opCaller = await tenantCaller(null as any, { userId: operator.id });
    const members = await opCaller.membership.list({ tenantId: TENANT_ID });
    assert(members.length === 2, "operator lists members via operatorProcedure");
    const outsiderCaller = await tenantCaller(null as any, { userId: outsider.id });
    await expectTrpcError(
      outsiderCaller.membership.list({ tenantId: TENANT_ID }),
      "FORBIDDEN",
      "non-member denied by operatorProcedure",
    );

    // ── Real auth path: wa_session → memberships snapshot ──────────────────
    const { signSessionToken, verifySessionToken } = await import("../../server/_core/auth");
    const { sdk } = await import("../../server/_core/sdk");
    const sessionUser = {
      id: String(operator.id), openId: operator.openId, email: operator.email,
      name: operator.name, role: "user" as const, tenantId: null, loginMethod: "keycloak",
    };
    const token1 = signSessionToken(sessionUser);

    // 12h default TTL on the issued token.
    const claims = jwt.verify(token1, ENV.jwtSecret) as any;
    assert(claims.exp - claims.iat === 12 * 3600, `default session TTL = 12h (got ${claims.exp - claims.iat}s)`);
    assert(typeof claims.jti === "string" && claims.jti.length > 0, "token carries a jti");
    assert(String(claims.uid) === String(operator.id), "token carries the numeric uid");

    const authed = await sdk.authenticateRequest({ headers: { cookie: `wa_session=${token1}` } } as any);
    assert(authed.id === operator.id, "authenticateRequest resolved the staff user");
    assert(Array.isArray(authed.memberships) && authed.memberships.includes(TENANT_ID), "authenticated user carries the membership snapshot");

    // ── Logout revokes the jti → SAME token rejected ───────────────────────
    const logoutCaller = appRouter.createCaller({
      user: null,
      req: { protocol: "http", headers: { cookie: `wa_session=${token1}` } },
      res: { clearCookie: () => {} },
    } as any);
    const out = await logoutCaller.auth.logout();
    assert(out.success, "logout succeeded");
    const [revRow] = await world.db
      .select()
      .from(schema.sessionRevocations)
      .where(eq(schema.sessionRevocations.jti, claims.jti))
      .limit(1);
    assert(revRow, "revocation row persisted for the token jti");
    let rejected = false;
    try {
      await sdk.authenticateRequest({ headers: { cookie: `wa_session=${token1}` } } as any);
    } catch (e: any) {
      rejected = /revoked/i.test(e?.message ?? "");
    }
    assert(rejected, "same token rejected after logout (jti revoked)");

    // ── Admin revoke-all → every session of the user rejected ─────────────
    const token2 = signSessionToken(sessionUser);
    const claims2 = verifySessionToken(token2)!;
    const authed2 = await sdk.authenticateRequest({ headers: { authorization: `Bearer ${token2}` } } as any);
    assert(authed2.id === operator.id, "fresh token authenticates (bearer)");
    await admin.auth.revokeUserSessions({ userId: operator.id });
    const [markerRow] = await world.db
      .select()
      .from(schema.sessionRevocations)
      .where(eq(schema.sessionRevocations.jti, `user:${operator.id}`))
      .limit(1);
    assert(markerRow, "revoke-all marker row persisted");
    let rejected2 = false;
    try {
      await sdk.authenticateRequest({ headers: { authorization: `Bearer ${token2}` } } as any);
    } catch (e: any) {
      rejected2 = /revoked/i.test(e?.message ?? "");
    }
    assert(rejected2, "revoked user's sessions rejected (revoke-all marker)");
    assert(claims2.jti !== claims.jti, "each issued token has a unique jti");

    // ── Tenant types: default retailer + backfill to hybrid ───────────────
    const [simTenant] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID)).limit(1);
    assert(simTenant.tenantType === "retailer", `tenantType defaults to retailer (got ${simTenant.tenantType})`);
    // The 0049 backfill ran before the sim seed, so the supplier tenant is
    // still 'retailer' here — apply the migration's backfill statement and
    // re-read (unit-level simulation of the production migration order).
    await world.backdate(
      `UPDATE "tenants" AS t SET "tenantType" = 'hybrid' FROM "supplier_profiles" AS sp WHERE sp."tenant_id" = t."id" AND t."tenantType" = 'retailer'`,
    );
    const [supplierTenant] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, SUPPLIER_TENANT_ID)).limit(1);
    assert(supplierTenant.tenantType === "hybrid", `supplier-profile tenant backfilled to hybrid (got ${supplierTenant.tenantType})`);
    const [simTenantAfter] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID)).limit(1);
    assert(simTenantAfter.tenantType === "retailer", "pure retailer untouched by the backfill");

    // ── Last-owner removal blocked ─────────────────────────────────────────
    const err = await expectTrpcError(
      admin.membership.remove({ tenantId: TENANT_ID, userId: owner.id }),
      "FORBIDDEN",
      "last-owner removal",
    );
    assert(err.message.includes("last owner"), "refusal names the last-owner guard");
    const stillThere = await admin.membership.list({ tenantId: TENANT_ID });
    assert(stillThere.some((m: any) => m.userId === String(owner.id) && m.role === "owner"), "owner membership intact");
    // Removing the operator is fine.
    const removed = await admin.membership.remove({ tenantId: TENANT_ID, userId: operator.id });
    assert(removed.removed === true, "operator removal succeeds");
  },
};
