/**
 * J213 — W33 embedded-api: enforcement surface.
 *
 * 1. Scope enforcement: a bills:read-only key cannot POST (403
 *    scope-required naming the missing scope); reads still work.
 * 2. Suspended client → 401 client-suspended (key stops working instantly).
 * 3. EMBEDDED_API_ENABLED unset (fail-closed default OFF) → the whole
 *    surface 404s, even with a valid key.
 * 4. Unknown key → 401 invalid-api-key; missing key → 401 missing-api-key.
 * 5. Per-client rate limit trips (limit set to 3/min → 4th request 429).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

const T = "j213-tenant";

async function api(world: World, key: string | null, method: string, path: string, body?: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  const res = await fetch(`${world.baseUrl}/api/embedded/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

export const journey: Journey = {
  id: "J213",
  name: "embedded API enforcement: scopes, suspension, disabled flag 404, rate limit trips",
  feature: "W33 embedded-api: auth/scope/flag/rate-limit enforcement",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    process.env.EMBEDDED_API_ENABLED = "true";

    await world.db.insert(schema.tenants).values({
      id: T, name: "J213 Embedded", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "2131", role: "owner",
    }).onConflictDoNothing();
    const owner = await tenantCaller(T, { userId: 2131 });
    await owner.vendorBills.create({
      tenantId: T, vendorName: "Preexisting Vendor", amountCents: 1_000,
    });
    const admin = await adminCaller();

    // ── 1. Scope enforcement: bills:read-only key ──────────────────────
    const ro = await admin.embedded.createClient({
      partnerName: "J213 ReadOnly", tenantId: T, scopes: ["bills:read"],
    });
    const list = await api(world, ro.apiKey, "GET", "/bills");
    assert(list.status === 200 && list.json.bills.length >= 1, "bills:read key can read");
    const denied = await api(world, ro.apiKey, "POST", "/bills", { vendorName: "Nope", amountCents: 100 });
    assert(denied.status === 403 && denied.json.error === "scope-required" && denied.json.scope === "bills:write",
      `read-only key cannot POST (got ${denied.status}: ${JSON.stringify(denied.json)})`);
    const deniedPay = await api(world, ro.apiKey, "POST", `/bills/${list.json.bills[0].id}/pay`, {});
    assert(deniedPay.status === 403 && deniedPay.json.scope === "payments:write", "read-only key cannot pay");
    const deniedInv = await api(world, ro.apiKey, "GET", "/invoices");
    assert(deniedInv.status === 403 && deniedInv.json.scope === "invoices:read", "read-only key cannot list invoices");

    // ── 2. Suspended client → 401 ──────────────────────────────────────
    const susp = await admin.embedded.createClient({
      partnerName: "J213 Suspended", tenantId: T, scopes: ["bills:read"],
    });
    const okBefore = await api(world, susp.apiKey, "GET", "/bills");
    assert(okBefore.status === 200, "key works before suspension");
    await admin.embedded.suspendClient({ clientId: susp.clientId });
    const afterSusp = await api(world, susp.apiKey, "GET", "/bills");
    assert(afterSusp.status === 401 && afterSusp.json.error === "client-suspended",
      `suspended client 401 (got ${afterSusp.status}: ${JSON.stringify(afterSusp.json)})`);

    // ── 3. Disabled flag → 404 even with a valid key ───────────────────
    delete process.env.EMBEDDED_API_ENABLED; // fail-closed default OFF
    const off = await api(world, ro.apiKey, "GET", "/bills");
    assert(off.status === 404, `surface 404s when disabled (got ${off.status})`);
    const offPost = await api(world, ro.apiKey, "POST", "/bills", { vendorName: "X", amountCents: 1 });
    assert(offPost.status === 404, "mutations 404 when disabled too");
    process.env.EMBEDDED_API_ENABLED = "true";

    // ── 4. Unknown / missing key → 401 ─────────────────────────────────
    const bad = await api(world, "emb_not_a_real_key_0000000000000000000000000000000", "GET", "/bills");
    assert(bad.status === 401 && bad.json.error === "invalid-api-key", "unknown key 401");
    const none = await api(world, null, "GET", "/bills");
    assert(none.status === 401 && none.json.error === "missing-api-key", "missing key 401");

    // ── 5. Per-client rate limit trips ─────────────────────────────────
    process.env.EMBEDDED_API_RATE_LIMIT_PER_MIN = "3";
    const rl = await admin.embedded.createClient({
      partnerName: "J213 RateLimited", tenantId: T, scopes: ["bills:read"],
    });
    let lastStatus = 0;
    for (let i = 1; i <= 3; i++) {
      lastStatus = (await api(world, rl.apiKey, "GET", "/bills")).status;
      assert(lastStatus === 200, `request ${i} within limit ok (got ${lastStatus})`);
    }
    const tripped = await api(world, rl.apiKey, "GET", "/bills");
    assert(tripped.status === 429 && tripped.json.error === "rate-limited",
      `4th request in the window trips 429 (got ${tripped.status}: ${JSON.stringify(tripped.json)})`);
    // The limit is PER CLIENT — a fresh client (no prior requests in this
    // window) is unaffected by rl's tripped limit.
    const fresh = await admin.embedded.createClient({
      partnerName: "J213 Fresh", tenantId: T, scopes: ["bills:read"],
    });
    const other = await api(world, fresh.apiKey, "GET", "/bills");
    assert(other.status === 200, `rate limit is per-client, not global (got ${other.status})`);
    delete process.env.EMBEDDED_API_RATE_LIMIT_PER_MIN;
  },
};
