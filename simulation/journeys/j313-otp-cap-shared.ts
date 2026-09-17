/**
 * === W42 secrets/auth (Coder B) ===
 * J313 — OTP attempt cap is DISTRIBUTED: two "replica" counter facades
 * backed by one shared store (standing in for two platform replicas sharing
 * Redis) jointly exhaust the per-phone hourly cap — the cap no longer
 * multiplies by replica count as it did with per-replica memory.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

/** Fake Redis INCR/EXPIRE server shared by both "replica" clients. */
function makeSharedRedis() {
  const data = new Map<string, { count: number; expiresAt: number }>();
  const client = () => ({
    async incr(key: string, ttlSeconds: number): Promise<number> {
      const now = Date.now();
      let e = data.get(key);
      if (!e || e.expiresAt <= now) {
        e = { count: 0, expiresAt: now + ttlSeconds * 1000 };
        data.set(key, e);
      }
      e.count += 1;
      return e.count;
    },
  });
  return { replicaA: client(), replicaB: client() };
}

export const journey: Journey = {
  id: "J313",
  name: "OTP attempt cap shared across replicas",
  feature: "PLT-11 distributed OTP/PIN attempt counters",
  async run(_world: World) {
    const phoneAuth = await import("../../server/routers/phoneAuth");
    const { replicaA, replicaB } = makeSharedRedis();
    const phone = "+15550000313";
    const LIMIT = 3;
    try {
      // Replica A serves 2 attempts, replica B serves the 3rd — all count
      // against ONE shared counter.
      phoneAuth.__setOtpCounterStoreForTest(replicaA);
      assert(await phoneAuth.bumpPhoneCounter("verify", phone, LIMIT) === true, "attempt 1 allowed (A)");
      assert(await phoneAuth.bumpPhoneCounter("verify", phone, LIMIT) === true, "attempt 2 allowed (A)");
      phoneAuth.__setOtpCounterStoreForTest(replicaB);
      assert(await phoneAuth.bumpPhoneCounter("verify", phone, LIMIT) === true, "attempt 3 allowed (B)");
      // 4th attempt is denied on BOTH replicas — the cap followed the phone,
      // not the process.
      assert(await phoneAuth.bumpPhoneCounter("verify", phone, LIMIT) === false, "attempt 4 denied (B)");
      phoneAuth.__setOtpCounterStoreForTest(replicaA);
      assert(await phoneAuth.bumpPhoneCounter("verify", phone, LIMIT) === false, "attempt 4 denied (A too)");
      // Send cap uses its own independent counter namespace.
      assert(await phoneAuth.bumpPhoneCounter("send", phone, LIMIT) === true, "send counter independent");
    } finally {
      phoneAuth.__setOtpCounterStoreForTest(null);
    }
  },
};
