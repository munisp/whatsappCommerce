/**
 * J53 — Keycloak session forgery. A realm user whose identity is NOT bound
 * to tenant B (and whose email matches no tenant-B user) attempts
 * keycloak.exchangeCode against tenant B → FORBIDDEN, no session minted, no
 * SSO profile written. The legitimate first-bind path (realm email matches a
 * registered tenant-B user) succeeds and provisions the SSO profile; a
 * replay with the now-bound sub succeeds even when the token email no longer
 * matches any tenant user. The REAL token exchange runs against the world's
 * scripted Keycloak realm (token calls recorded for hard assertions).
 */
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { ENV } from "../../server/_core/env";
import { SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { adminCaller, expectTrpcError, publicCaller } from "./helpers";

const REDIRECT = "https://portal.sim.local/callback";

async function saveKcConfig(tenantId: string, realm: string) {
  const admin = await adminCaller();
  const r = await admin.keycloak.saveConfig({
    tenantId,
    serverUrl: process.env.KEYCLOAK_URL!,
    realm,
    clientId: `client-${realm}`,
    clientSecret: `secret-${realm}`,
    enableSso: true,
  });
  assert(r.ok, `keycloak config saved for ${tenantId}`);
}

export const journey: Journey = {
  id: "J53",
  name: "keycloak session forgery",
  feature: "exchangeCode identity↔tenant binding",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    await saveKcConfig(SUPPLIER_TENANT_ID, "realm-b");
    await saveKcConfig(TENANT_ID, "realm-a");

    // Tenant B has one registered portal user (the owner).
    await world.db.insert(schema.users).values({
      openId: "w12-kc-owner-b",
      email: "owner@tenantb.sim",
      name: "Tenant B Owner",
      loginMethod: "keycloak",
      role: "user",
      tenantId: SUPPLIER_TENANT_ID,
      lastSignedIn: new Date(),
    });

    const pub = await publicCaller();
    const ssoProfilesFor = async (tenantId: string) =>
      world.db.select().from(schema.tenantSsoProfiles).where(eq(schema.tenantSsoProfiles.tenantId, tenantId));

    // ── Attack 1: tenant A realm user forges a session for tenant B ────────
    // The realm issues a perfectly valid token — but the identity is neither
    // bound to tenant B nor email-matched to any tenant-B user.
    world.keycloak.scriptCode("code-attacker", {
      sub: "kc-sub-attacker",
      email: "attacker@tenanta.sim",
      name: "Mallory",
      realm_access: { roles: ["admin"] }, // realm roles must NOT grant access
    });
    await expectTrpcError(
      pub.keycloak.exchangeCode({ tenantId: SUPPLIER_TENANT_ID, code: "code-attacker", redirectUri: REDIRECT }),
      "FORBIDDEN",
      "cross-tenant exchangeCode",
    );
    // The token exchange really happened (recorded), but nothing was minted.
    assert(world.keycloak.tokenCalls.length === 1, "attacker's token POST reached the realm");
    assert(world.keycloak.tokenCalls[0].realm === "realm-b", "token POST hit tenant B's realm");
    assert((await ssoProfilesFor(SUPPLIER_TENANT_ID)).length === 0, "no SSO profile minted for the attacker");

    // ── Attack 2: same trick against tenant A (also unbound) ──────────────
    await expectTrpcError(
      pub.keycloak.exchangeCode({ tenantId: TENANT_ID, code: "code-attacker", redirectUri: REDIRECT }),
      "FORBIDDEN",
      "unbound exchangeCode against tenant A",
    );
    assert((await ssoProfilesFor(TENANT_ID)).length === 0, "no SSO profile minted for tenant A");

    // ── Legitimate first-bind: realm email matches tenant B's owner ───────
    world.keycloak.scriptCode("code-owner-b", {
      sub: "kc-sub-owner-b",
      email: "Owner@TenantB.sim", // case-insensitive match
      name: "Tenant B Owner",
      realm_access: { roles: ["admin"] },
    });
    const first = await pub.keycloak.exchangeCode({ tenantId: SUPPLIER_TENANT_ID, code: "code-owner-b", redirectUri: REDIRECT });
    assert(first.sessionToken && first.tenantId === SUPPLIER_TENANT_ID, "first-bind minted a tenant-B session");
    assert(first.portalRole === "admin", `realm admin role mapped to portal admin (got ${first.portalRole})`);
    const decoded = jwt.verify(first.sessionToken, ENV.jwtSecret) as any;
    assert(decoded.tenantId === SUPPLIER_TENANT_ID, "session token is scoped to tenant B");
    assert(decoded.sub === "kc-sub-owner-b", "session carries the realm sub");
    assert(decoded.loginMethod === "keycloak_sso", "session is marked keycloak_sso");
    const [profile] = await ssoProfilesFor(SUPPLIER_TENANT_ID);
    assert(profile, "SSO profile provisioned on first bind");
    assert(profile.ssoSub === "kc-sub-owner-b", "profile bound to the realm sub");
    assert(Number(profile.ssoLoginCount) === 1, "login count = 1 after first bind");

    // ── Replay with the bound sub: email no longer needs to match ─────────
    world.keycloak.scriptCode("code-owner-b2", {
      sub: "kc-sub-owner-b",
      email: "changed-identity@elsewhere.sim", // bound sub wins over email
      name: "Tenant B Owner",
    });
    const replay = await pub.keycloak.exchangeCode({ tenantId: SUPPLIER_TENANT_ID, code: "code-owner-b2", redirectUri: REDIRECT });
    assert(replay.sessionToken, "replay with bound sub succeeds");
    assert(replay.portalRole === "agent", `no realm roles → portal agent (got ${replay.portalRole})`);
    const [profile2] = await ssoProfilesFor(SUPPLIER_TENANT_ID);
    assert(Number(profile2.ssoLoginCount) === 2, "login count incremented on replay");

    // The attacker is still locked out after a legitimate profile exists.
    await expectTrpcError(
      pub.keycloak.exchangeCode({ tenantId: SUPPLIER_TENANT_ID, code: "code-attacker", redirectUri: REDIRECT }),
      "FORBIDDEN",
      "attacker still forbidden after legitimate bind",
    );
    // attack1 (realm-b) + attack2 (realm-a) + first-bind + replay + final attack
    assert(world.keycloak.tokenCalls.length === 5, `5 token exchanges recorded (got ${world.keycloak.tokenCalls.length})`);
    assert(world.keycloak.tokenCalls.every((c) => c.params.grant_type === "authorization_code"), "all calls were authorization_code exchanges");
  },
};
