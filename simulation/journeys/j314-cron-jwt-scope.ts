/**
 * === W42 secrets/auth (Coder B) ===
 * J314 — Cron JWT per-route scope: a token minted for /api/scheduled/A is
 * REJECTED when presented to /api/scheduled/B (403 semantics via
 * CronAuthError), and accepted only on its own route.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

function claimsFor(scope: string, jti: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    openId: "cron_scheduler",
    task_uid: `scheduler:${scope}`,
    scope,
    jti,
    iat: now,
    exp: now + 300,
  };
}

export const journey: Journey = {
  id: "J314",
  name: "Wrong-scope cron JWT rejected",
  feature: "PLT-13 per-route cron JWT scope claims",
  async run(_world: World) {
    const cronAuth = await import("../../server/_core/cronAuth");
    // In-memory replay cache so the journey never depends on a live Redis.
    const seen = new Set<string>();
    cronAuth.__setCronReplayStoreForTest({
      async setIfAbsent(key: string) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });
    try {
      const routeA = "/api/scheduled/cart-recovery";
      const routeB = "/api/scheduled/odoo-sync";

      // Correct scope → accepted on its own route.
      await cronAuth.assertCronClaimsHardened(claimsFor(routeA, "j314-good-1"), routeA);

      // Same token shape presented to a DIFFERENT route → rejected.
      let wrongRoute = false;
      try {
        await cronAuth.assertCronClaimsHardened(claimsFor(routeA, "j314-good-2"), routeB);
      } catch (e: any) {
        wrongRoute = e?.name === "CronAuthError" && /cannot invoke/.test(e.message);
      }
      assert(wrongRoute, "token scoped to route A is a CronAuthError on route B");

      // scope/task_uid mismatch → rejected.
      let mismatch = false;
      try {
        const c = claimsFor(routeA, "j314-good-3");
        c.task_uid = `scheduler:${routeB}`;
        await cronAuth.assertCronClaimsHardened(c, routeA);
      } catch (e: any) {
        mismatch = e?.name === "CronAuthError" && /task_uid/.test(e.message);
      }
      assert(mismatch, "scope ≠ task_uid rejected");

      // Missing scope entirely (legacy-shaped token) → rejected fail-closed.
      let noScope = false;
      try {
        const c = claimsFor(routeA, "j314-good-4") as Record<string, unknown>;
        delete c.scope;
        await cronAuth.assertCronClaimsHardened(c, routeA);
      } catch (e: any) {
        noScope = e?.name === "CronAuthError" && /scope/.test(e.message);
      }
      assert(noScope, "missing scope claim rejected");

      // Over-long lifetime → rejected.
      let tooLong = false;
      try {
        const c = claimsFor(routeA, "j314-good-5");
        c.exp = c.iat + 3600;
        await cronAuth.assertCronClaimsHardened(c, routeA);
      } catch (e: any) {
        tooLong = e?.name === "CronAuthError" && /lifetime/.test(e.message);
      }
      assert(tooLong, "over-long token lifetime rejected");
    } finally {
      cronAuth.__setCronReplayStoreForTest(null);
    }
  },
};
