/**
 * === W39 web security (Coder B, PLT-3) ===
 * J268 — Session cookie SameSite policy. The wa_session cookie was issued
 * SameSite=None, letting any cross-site POST carry ambient auth. Now:
 *   1. getSessionCookieOptions issues SameSite=Lax (+ httpOnly, secure on
 *      https) — compatible with the OAuth callback (top-level GET
 *      navigation) and same-origin tRPC clients.
 *   2. tRPC same-origin flow unaffected: a same-origin POST to /api/trpc
 *      carrying a cookie reaches the tRPC layer (not blocked by CSRF
 *      middleware or cookie policy assumptions).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J268",
  name: "session cookie SameSite=Lax + same-origin tRPC flow intact",
  feature: "PLT-3 SameSite=Lax session cookie (server/_core/cookies.ts)",
  async run(world: World) {
    const { getSessionCookieOptions } = await import("../../server/_core/cookies");

    // 1. SameSite=Lax on both plain and forwarded-https requests.
    const plain = getSessionCookieOptions({ protocol: "http", headers: {} } as any);
    assert(plain.sameSite === "lax", `sameSite must be lax (got ${plain.sameSite})`);
    assert(plain.httpOnly === true, "httpOnly preserved");
    const fwd = getSessionCookieOptions({ protocol: "http", headers: { "x-forwarded-proto": "https" } } as any);
    assert(fwd.sameSite === "lax" && fwd.secure === true, "secure+lux on forwarded https");

    // 2. Same-origin tRPC client flow intact: POST with cookie + same-origin
    //    Origin header is answered by the tRPC layer (any non-CSRF response),
    //    proving the W39 layers don't break first-party clients.
    const res = await fetch(`${world.baseUrl}/api/trpc/auth.me`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "wa_session=fake-journey-token",
        Origin: world.baseUrl,
      },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => null);
    assert(body?.error !== "csrf-check-failed",
      `same-origin tRPC POST must not be CSRF-blocked (got ${res.status})`);
    assert(res.status !== 403, `same-origin tRPC POST reaches tRPC (got ${res.status})`);
  },
};
