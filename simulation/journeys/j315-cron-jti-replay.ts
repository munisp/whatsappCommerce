/**
 * === W42 secrets/auth (Coder B) ===
 * J315 — Cron JWT replay protection: re-presenting a consumed jti is
 * rejected (replay detected); a fresh jti on the same route is accepted.
 * The replay cache is shared, so a token captured and replayed against a
 * DIFFERENT replica is still denied.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J315",
  name: "Cron JWT jti replay rejected",
  feature: "PLT-13 jti replay protection with short exp",
  async run(_world: World) {
    const cronAuth = await import("../../server/_core/cronAuth");
    // One shared backing store, two "replica" facades.
    const data = new Map<string, number>();
    const facade = () => ({
      async setIfAbsent(key: string, ttlSeconds: number) {
        const now = Date.now();
        const exp = data.get(key);
        if (exp !== undefined && exp > now) return false;
        data.set(key, now + ttlSeconds * 1000);
        return true;
      },
    });
    const replicaA = facade();
    const replicaB = facade();
    const route = "/api/scheduled/wa-send-retry";
    const now = Math.floor(Date.now() / 1000);
    const token = {
      openId: "cron_scheduler",
      task_uid: `scheduler:${route}`,
      scope: route,
      jti: "j315-captured-jti",
      iat: now,
      exp: now + 300,
    };
    try {
      // First use on replica A — accepted.
      cronAuth.__setCronReplayStoreForTest(replicaA);
      await cronAuth.assertCronClaimsHardened({ ...token }, route);

      // Replay of the SAME jti against replica B — denied (shared cache).
      cronAuth.__setCronReplayStoreForTest(replicaB);
      let replayed = false;
      try {
        await cronAuth.assertCronClaimsHardened({ ...token }, route);
      } catch (e: any) {
        replayed = e?.name === "CronAuthError" && /replay/i.test(e.message);
      }
      assert(replayed, "replayed jti denied on a different replica");

      // A fresh jti on the same route — accepted (not a blanket route block).
      let freshOk = true;
      try {
        await cronAuth.assertCronClaimsHardened({ ...token, jti: "j315-fresh-jti" }, route);
      } catch {
        freshOk = false;
      }
      assert(freshOk, "fresh jti accepted");

      // Missing jti — rejected fail-closed.
      let noJti = false;
      try {
        const c = { ...token, jti: undefined } as Record<string, unknown>;
        delete c.jti;
        await cronAuth.assertCronClaimsHardened(c, route);
      } catch (e: any) {
        noJti = e?.name === "CronAuthError" && /jti/.test(e.message);
      }
      assert(noJti, "missing jti rejected");
    } finally {
      cronAuth.__setCronReplayStoreForTest(null);
    }
  },
};
