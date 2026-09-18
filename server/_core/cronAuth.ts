/**
 * server/_core/cronAuth.ts — W42 (PLT-13) hardening for the local cron JWT
 * fast-path (sdk.ts). The shared CRON_JWT secret previously minted tokens
 * that could invoke ANY /api/scheduled/* route and, once captured, replayed
 * forever. This module adds:
 *
 *   1. Per-route SCOPE: tokens must carry `scope` = the exact scheduled
 *      route path they may invoke; the verifier checks it against the
 *      request path and against task_uid (scheduler:<scope>). A token minted
 *      for route A is a 403 on route B.
 *   2. REPLAY protection: tokens must carry a unique `jti`; consumed jtis
 *      are remembered in Redis (SET NX, TTL = remaining token lifetime) so a
 *      captured token cannot be replayed. A short maximum lifetime
 *      (MAX_CRON_TOKEN_TTL_SECONDS) is enforced from iat→exp.
 *
 * Outage policy mirrors _core/rateLimit.ts: production fails CLOSED when the
 * replay cache is unreachable (a replay cache that cannot remember is no
 * replay cache); dev/test falls back to a per-process Set with a warning.
 */
import { isProd } from "./env";

/** Scheduler-minted tokens live 300s; anything above this is rejected. */
export const MAX_CRON_TOKEN_TTL_SECONDS = 600;

export class CronAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronAuthError";
  }
}

// ── jti replay cache ─────────────────────────────────────────────────────────
const consumedJtis = new Map<string, number>(); // jti → expiry epoch ms (dev fallback)

/** Minimal atomic set-if-absent surface (Redis SET NX PX or a test double). */
export interface CronReplayStore {
  /** Returns true when the jti was NEWLY recorded (first use). */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
}
let injectedReplayStore: CronReplayStore | null = null;
/** Test/sim hook: share one replay cache across "replica" instances. */
export function __setCronReplayStoreForTest(store: CronReplayStore | null): void {
  injectedReplayStore = store;
}

function consumeJtiMemory(jti: string, expEpochSeconds: number): boolean {
  const now = Date.now();
  // Opportunistic sweep of expired entries (bounded: cron volume is small).
  consumedJtis.forEach((expMs, k) => {
    if (expMs <= now) consumedJtis.delete(k);
  });
  if (consumedJtis.has(jti)) return false;
  consumedJtis.set(jti, expEpochSeconds * 1000);
  return true;
}

/**
 * Record `jti` as consumed until `expEpochSeconds`. Returns true on first
 * use, false on REPLAY. Throws CronAuthError in production when no replay
 * cache is available (fail closed).
 */
export async function consumeCronJti(jti: string, expEpochSeconds: number): Promise<boolean> {
  const ttl = Math.max(1, Math.floor(expEpochSeconds - Date.now() / 1000));
  const key = `cron:jti:${jti}`;
  if (injectedReplayStore) {
    return injectedReplayStore.setIfAbsent(key, ttl);
  }
  try {
    const { getRedis } = await import("../redis");
    const redis = await getRedis();
    if (!redis) throw new Error("Redis client is not connected");
    const res = await redis.set(key, "1", "EX", ttl, "NX");
    return res === "OK";
  } catch (e: any) {
    if (isProd) {
      throw new CronAuthError(
        `cron replay cache unavailable (${e?.message ?? e}) — refusing cron token (fail closed)`,
      );
    }
    console.warn(`[cronAuth] Redis replay cache unavailable (${e?.message ?? e}) — dev in-memory fallback`);
    return consumeJtiMemory(jti, expEpochSeconds);
  }
}

/**
 * Validate the W42 claims of an already-signature-verified cron token.
 * Throws CronAuthError on any violation (caller maps to 403).
 *
 * @param claims   decoded JWT payload
 * @param reqPath  the request path being authenticated (req.path)
 */
export async function assertCronClaimsHardened(
  claims: Record<string, unknown>,
  reqPath: string,
): Promise<void> {
  const taskUid = claims.task_uid ?? claims.taskUid;

  // 1. Per-route scope (required — the shipped scheduler always signs it).
  const scope = claims.scope;
  if (typeof scope !== "string" || !scope.startsWith("/api/scheduled/")) {
    throw new CronAuthError("Cron token missing/invalid scope claim");
  }
  if (taskUid !== `scheduler:${scope}`) {
    throw new CronAuthError("Cron token scope does not match task_uid");
  }
  if (reqPath && reqPath !== scope) {
    throw new CronAuthError(`Cron token scoped to ${scope} cannot invoke ${reqPath}`);
  }

  // 2. Short lifetime enforced from iat→exp (jose already checks exp>now).
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (iat === null || exp === null || exp - iat > MAX_CRON_TOKEN_TTL_SECONDS) {
    throw new CronAuthError("Cron token lifetime missing or too long");
  }

  // 3. Replay protection via unique jti.
  const jti = claims.jti;
  if (typeof jti !== "string" || jti.length < 8 || jti.length > 128) {
    throw new CronAuthError("Cron token missing/invalid jti");
  }
  const firstUse = await consumeCronJti(jti, exp);
  if (!firstUse) {
    throw new CronAuthError("Cron token replay detected (jti already consumed)");
  }
}
