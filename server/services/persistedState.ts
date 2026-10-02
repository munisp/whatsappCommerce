// === W60 persistence ===
/**
 * persistedState.ts — tiny shared helper for the W60 "Redis SET NX PX with
 * production fail-closed" pattern (audit W60-A MEDIUM hardening):
 *
 *   setNxOnce(key, ttlMs)  → true when THIS caller won the claim (key was
 *                            absent), false when the key already exists.
 *                            Throws PersistedStateUnavailableError in
 *                            production when Redis is unreachable — for
 *                            auth/replay/suppression-adjacent keys a cache
 *                            that cannot remember is worse than no cache.
 *                            Outside production (dev/test/sim) falls back to
 *                            a per-process Map with lazy expiry, preserving
 *                            the pre-W60 behavior so tests need no Redis.
 *
 * Reuses the shared client conventions from server/redis.ts (getRedis).
 */
import { isProd } from "../_core/env";
import { getRedis } from "../redis";

export class PersistedStateUnavailableError extends Error {
  constructor(label: string, cause: unknown) {
    super(`[persistedState] ${label}: Redis unavailable — refusing (production fail-closed): ${String((cause as any)?.message ?? cause)}`);
    this.name = "PersistedStateUnavailableError";
  }
}

/** Dev/test-only fallback: key → expiry epoch ms. */
const memoryClaims = new Map<string, number>();

/** Test hook: wipe the dev fallback claims. */
export function __clearPersistedStateMemory(): void {
  memoryClaims.clear();
}

function memorySetNx(key: string, ttlMs: number): boolean {
  const now = Date.now();
  memoryClaims.forEach((exp, k) => {
    if (exp <= now) memoryClaims.delete(k);
  });
  if (memoryClaims.has(key)) return false;
  memoryClaims.set(key, now + ttlMs);
  return true;
}

/**
 * Atomic set-if-absent with a millisecond TTL. Returns true on first claim,
 * false on replay/existing key. Production + Redis down → throws
 * PersistedStateUnavailableError (fail closed); dev/test → in-memory.
 */
export async function setNxOnce(key: string, ttlMs: number, opts: { label: string }): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (!redis) throw new Error("Redis client is not connected");
    const res = await redis.set(key, "1", "PX", Math.max(1, Math.floor(ttlMs)), "NX");
    return res === "OK";
  } catch (e: any) {
    if (isProd) throw new PersistedStateUnavailableError(opts.label, e);
    console.warn(`[persistedState] ${opts.label}: Redis unavailable (${e?.message ?? e}) — dev in-memory fallback`);
    return memorySetNx(key, ttlMs);
  }
}
// === END W60 persistence ===
