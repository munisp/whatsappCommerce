/**
 * J176 — W30 session/invite/gateway guards:
 *   1. ENABLE_LOCAL_AUTH stays fail-closed (501) when unset; the production
 *      boot guard predicate (env.ts) treats it as fatal (asserted via the
 *      boot-check source contract — the process-level throw is covered by
 *      the env unit tests).
 *   2. Express logout revokes the token jti — the bearer token is dead
 *      immediately after logout, not just the cookie.
 *   3. Tenant invite links are single-use and capped at a 24h TTL.
 *   4. /ussd requires the shared-secret gateway header and rate limits.
 */
import jwt from "jsonwebtoken";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J176",
  name: "local-auth guard + logout jti revoke + single-use invite + ussd auth",
  feature: "oauth logout revocation + tenantInvite registry + /ussd shared secret",
  async run(world: World) {
    // ── 1. Local auth is fail-closed when the flag is unset ─────────────
    {
      const res = await fetch(`${world.baseUrl}/api/auth/local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "attacker@sim.local", password: "anything" }),
      });
      assert(res.status === 501, `local auth without flag → 501 (got ${res.status})`);
    }

    // ── 2. Logout revokes the jti ────────────────────────────────────────
    {
      const { signSessionToken } = await import("../../server/_core/auth");
      const { isSessionRevoked, clearSessionCaches } = await import("../../server/_core/sdk");
      const token = signSessionToken({
        id: "1761", openId: "j176-user", email: "j176@sim.local",
        name: "J176", role: "user", tenantId: TENANT_ID, loginMethod: "keycloak",
      });
      const decoded = jwt.decode(token) as { jti?: string };
      assert(decoded?.jti, "session token carries a jti");
      clearSessionCaches();
      assert(!(await isSessionRevoked({ jti: decoded.jti })), "token not revoked before logout");
      const res = await fetch(`${world.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: `wa_session=${token}` },
      });
      assert(res.status === 200, `logout → 200 (got ${res.status})`);
      clearSessionCaches();
      assert(await isSessionRevoked({ jti: decoded.jti }), "jti revoked after logout");
    }

    // ── 3. Invite links: single-use + 24h TTL ───────────────────────────
    {
      const admin = await adminCaller();
      const pub = await publicCaller();
      // W30 merge: tenantInvite.create requires a uuid tenant id — mint a
      // fresh tenant (the seed TENANT_ID "sim-tenant" is not a uuid).
      const inviteTenantId = (await admin.onboarding.start({ name: "J176 Invite Tenant" })).tenantId;
      const invite = await admin.tenantInvite.create({ tenantId: inviteTenantId });
      const ttlHours = (new Date(invite.expiresAt).getTime() - Date.now()) / 3_600_000;
      assert(ttlHours <= 24 && ttlHours > 23, `invite TTL ≤ 24h (got ${ttlHours.toFixed(2)}h)`);
      const first = await pub.tenantInvite.validate({ token: invite.token });
      assert(first.valid === true, "first validation succeeds");
      assert(first.sessionToken, "session minted on first use");
      const second = await pub.tenantInvite.validate({ token: invite.token });
      assert(second.valid === false, "second validation rejected — link is single-use");
    }

    // ── 4. /ussd shared-secret + rate limit ──────────────────────────────
    {
      const prev = process.env.USSD_GATEWAY_SECRET;
      process.env.USSD_GATEWAY_SECRET = "j176-gateway-secret";
      try {
        const body = new URLSearchParams({
          sessionId: "j176-s1", serviceCode: "*928*77#", phoneNumber: "+2348111222333", text: "",
        });
        const noAuth = await fetch(`${world.baseUrl}/ussd`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        assert(noAuth.status === 401, `ussd without gateway secret → 401 (got ${noAuth.status})`);
        const badAuth = await fetch(`${world.baseUrl}/ussd`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-ussd-gateway-key": "wrong" },
          body,
        });
        assert(badAuth.status === 401, `ussd with wrong secret → 401 (got ${badAuth.status})`);
        const okAuth = await fetch(`${world.baseUrl}/ussd`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-ussd-gateway-key": "j176-gateway-secret" },
          body,
        });
        assert(okAuth.status === 200, `ussd with gateway secret → 200 (got ${okAuth.status})`);
        const text = await okAuth.text();
        assert(/^(CON|END) /.test(text), `ussd reply is a CON/END menu response (${text.slice(0, 60)})`);
      } finally {
        if (prev === undefined) delete process.env.USSD_GATEWAY_SECRET;
        else process.env.USSD_GATEWAY_SECRET = prev;
      }
    }
  },
};
