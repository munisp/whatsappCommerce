/**
 * === W39 web security (Coder B, PLT-3) ===
 * J267 — CSRF Origin-verification middleware (live HTTP against the booted
 * simulation server):
 *   1. Cross-origin POST carrying a session cookie → 403 csrf-check-failed.
 *   2. Same-origin POST with the cookie → passes the CSRF layer (downstream
 *      auth may still 401, but never a CSRF 403).
 *   3. Webhook paths are exempt — a PSP webhook with a foreign Origin is NOT
 *      CSRF-blocked (it still fails its own signature check, 401).
 *   4. Internal service-to-service calls (X-Internal-Api-Key header) are
 *      exempt from the origin requirement.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J267",
  name: "CSRF origin check: cross-origin 403, same-origin OK, webhook unaffected",
  feature: "PLT-3 CSRF origin middleware (server/_core/csrf.ts)",
  async run(world: World) {
    const trpcPath = "/api/trpc/system.health";
    const cookie = "wa_session=fake-journey-token";

    // 1. Cross-origin cookie-authed mutation → 403.
    {
      const res = await fetch(`${world.baseUrl}${trpcPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "https://evil.example",
        },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      assert(res.status === 403, `cross-origin POST with cookie → 403 (got ${res.status})`);
      assert(body?.error === "csrf-check-failed", `403 carries csrf-check-failed (got ${JSON.stringify(body)})`);
    }

    // 2. Same-origin cookie-authed mutation → NOT a CSRF 403 (tRPC auth may
    //    reject the fake token downstream — that is fine).
    {
      const res = await fetch(`${world.baseUrl}${trpcPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: world.baseUrl,
        },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      assert(body?.error !== "csrf-check-failed", `same-origin request must pass CSRF layer (got ${res.status} ${JSON.stringify(body)?.slice(0, 120)})`);
    }

    // 3. Webhook unaffected: paystack webhook with foreign Origin is NOT
    //    CSRF-blocked — it fails its own signature gate (401) instead.
    {
      const res = await fetch(`${world.baseUrl}/api/webhooks/paystack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "x-paystack-signature": "deadbeef",
        },
        body: JSON.stringify({ event: "charge.success", data: {} }),
      });
      const body = await res.json().catch(() => null);
      assert(res.status !== 403 || body?.error !== "csrf-check-failed",
        `webhook path must be exempt from CSRF origin check (got ${res.status} ${JSON.stringify(body)})`);
      // The webhook's own signature gate is independent: 401 when the secret
      // is configured (production), 200-ack in the non-production sim world
      // where verification is explicitly skipped. Either way it was NOT the
      // CSRF layer answering.
      assert(res.status === 401 || res.status === 200,
        `webhook answered by its own handler, not the CSRF layer (got ${res.status})`);
    }

    // 4. Internal service call with X-Internal-Api-Key header → exempt from
    //    the origin requirement (its own token auth still applies).
    {
      const res = await fetch(`${world.baseUrl}/api/internal/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "https://evil.example",
          "X-Internal-Api-Key": "wrong-key-but-header-present",
        },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      assert(body?.error !== "csrf-check-failed",
        `internal-token call must be exempt from CSRF origin check (got ${res.status} ${JSON.stringify(body)?.slice(0, 120)})`);
    }
  },
};
