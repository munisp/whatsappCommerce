// === W48 api-db ===
/**
 * J476 — PERF-API-13/19 P2 batch:
 *   (a) PERF-API-19: the blanket 50mb JSON body limit is now 2mb by default
 *       (large-body allowlist: /api/delivery/proof keeps 12mb) — an oversized
 *       body is rejected 413 BEFORE hitting a route handler.
 *   (b) PERF-API-13: template.list's default-template seeding is ONE
 *       multi-row insert; seeding stays idempotent (second list does not
 *       duplicate).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J476",
  name: "JSON body limit 2mb default + template seed multi-row (PERF-API-13/19)",
  feature: "oversized JSON rejected 413 pre-route; DEFAULT_TEMPLATES seeded once via one insert",
  async run(world: World) {
    // (a) 3MB JSON body → 413 from the global parser (route-level 5mb parser
    //     on /api/internal/events never engages — the global limit is tighter).
    const bigBody = JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) });
    const res = await fetch(`${world.baseUrl}/api/internal/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bigBody,
    });
    assert(res.status === 413, `oversized JSON rejected 413 (got ${res.status})`);

    // Small body reaches the route (401/403/404/500 — anything but 413).
    const small = await fetch(`${world.baseUrl}/api/internal/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "j476-probe" }),
    });
    assert(small.status !== 413, `small body not limited (got ${small.status})`);

    // (b) template seeding — a fresh tenant's first list seeds the defaults.
    const tenantId = `tenant-j476-${Date.now().toString(36)}`;
    const caller = await tenantCaller(tenantId);
    const first = await caller.template.list({ limit: 100, offset: 0 });
    assert(first.templates.length > 0 && first.total === first.templates.length,
      `defaults seeded in one shot (${first.templates.length} templates)`);
    const second = await caller.template.list({ limit: 100, offset: 0 });
    assert(second.total === first.total, "second list does NOT re-seed (idempotent, no dupes)");
    await world.settle(50);
  },
};
