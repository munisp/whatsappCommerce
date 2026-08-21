/**
 * chatSession.ts — Conversational session state machine.
 *
 * Tracks where a caller is inside the menu/use-case flows so multi-step
 * interactions (menu selection, booking slot-filling, support intake,
 * consent capture) survive across messages.
 *
 * Storage: Redis (key wa:sess:{tenantId}:{phone}, TTL 1800s), reusing the
 * shared client from server/redis.ts.
 *   - development/test without Redis: in-memory Map fallback (with the same
 *     TTL semantics) so local dev and unit tests work out of the box.
 *   - production without Redis: log an error and operate STATELESSLY (every
 *     getSession misses, saves are dropped) — the caller falls back to the
 *     stateless menu/NLP path. Never crash on a missing session store.
 */

import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import type { UseCaseId } from "./waMenu";

export const SESSION_TTL_SECONDS = 1800;

export type SessionMode = "menu" | "usecase" | "nlp";

export interface ChatSession {
  tenantId: string;
  phone: string;
  mode: SessionMode;
  /** Active use case while mode === "usecase". */
  activeUseCase?: UseCaseId;
  /** Use-case-specific slot step (e.g. "choose_service"). */
  step?: string;
  /** Slot data collected so far (booking details, etc.). */
  data?: Record<string, unknown>;
  /** True after the menu was shown and we expect a numeric selection. */
  awaitingMenuSelection?: boolean;
  /** True while we wait for the NDPR consent YES/NO reply. */
  awaitingConsent?: boolean;
  /** W27: true while we wait for a language-picker reply. */
  awaitingLanguageChoice?: boolean;
  /**
   * Optimistic-concurrency version. Every save bumps it; saveSessionCas
   * refuses to overwrite a session whose stored version differs from the
   * version the caller based its mutation on (prevents lost updates when
   * two webhook deliveries race the same phone).
   */
  casVersion?: number;
  updatedAt: number;
}

export function sessionKey(tenantId: string, phone: string): string {
  return `wa:sess:${tenantId}:${phone}`;
}

// ── Dev/test-only in-memory fallback ─────────────────────────────────────────
const memoryStore = new Map<string, { value: string; expiresAt: number }>();

function memoryGet(key: string): string | null {
  const row = memoryStore.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return row.value;
}

function memorySet(key: string, value: string, ttlSeconds: number): void {
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function memoryDel(key: string): void {
  memoryStore.delete(key);
}

/** Test helper: wipe the in-memory fallback store. */
export function __clearMemorySessions(): void {
  memoryStore.clear();
}

let prodErrorLogged = false;
function logProdMissingRedis(): void {
  if (prodErrorLogged) return;
  prodErrorLogged = true;
  console.error(
    "[chatSession] Redis unavailable in production — conversational sessions " +
    "are stateless until Redis is restored (menu falls back to stateless rendering).",
  );
}

export function newSession(tenantId: string, phone: string): ChatSession {
  return { tenantId, phone, mode: "menu", updatedAt: Date.now() };
}

export async function getSession(tenantId: string, phone: string): Promise<ChatSession | null> {
  const key = sessionKey(tenantId, phone);
  try {
    const redis = await getRedis();
    if (redis) {
      const raw = await redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ChatSession;
      if (!parsed || parsed.tenantId !== tenantId || parsed.phone !== phone) return null;
      return parsed;
    }
  } catch (e: any) {
    console.warn("[chatSession] redis get failed:", e?.message);
  }
  if (isProd) {
    logProdMissingRedis();
    return null;
  }
  const raw = memoryGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}

export async function saveSession(
  session: ChatSession,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<void> {
  const key = sessionKey(session.tenantId, session.phone);
  const value = JSON.stringify({
    ...session,
    casVersion: (session.casVersion ?? 0) + 1,
    updatedAt: Date.now(),
  });
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.setex(key, ttlSeconds, value);
      return;
    }
  } catch (e: any) {
    console.warn("[chatSession] redis set failed:", e?.message);
  }
  if (isProd) {
    logProdMissingRedis();
    return; // stateless fallback — do not silently persist in process memory
  }
  memorySet(key, value, ttlSeconds);
}

/**
 * Compare-and-swap session write: persists `session` only when the currently
 * stored session still has `expectedVersion` (the casVersion the caller read
 * before mutating). Returns false on a version conflict (concurrent writer
 * won — caller must reload and re-apply) or when the session no longer
 * exists. Atomic in Redis via a Lua check-and-set; the dev/test in-memory
 * fallback is single-threaded and checks synchronously.
 */
export async function saveSessionCas(
  session: ChatSession,
  expectedVersion: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<boolean> {
  const key = sessionKey(session.tenantId, session.phone);
  const value = JSON.stringify({
    ...session,
    casVersion: expectedVersion + 1,
    updatedAt: Date.now(),
  });
  try {
    const redis = await getRedis();
    if (redis) {
      const result = await redis.eval(
        `local cur = redis.call('GET', KEYS[1])
         if not cur then return 0 end
         local ok, obj = pcall(cjson.decode, cur)
         if not ok or type(obj) ~= 'table' then return 0 end
         local v = obj['casVersion'] or 0
         if v ~= tonumber(ARGV[1]) then return 0 end
         redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), ARGV[3])
         return 1`,
        1,
        key,
        String(expectedVersion),
        String(ttlSeconds),
        value,
      );
      return Number(result) === 1;
    }
  } catch (e: any) {
    console.warn("[chatSession] redis CAS failed:", e?.message);
  }
  if (isProd) {
    logProdMissingRedis();
    return false;
  }
  const raw = memoryGet(key);
  if (!raw) return false;
  try {
    const cur = JSON.parse(raw) as ChatSession;
    if ((cur.casVersion ?? 0) !== expectedVersion) return false;
  } catch {
    return false;
  }
  memorySet(key, value, ttlSeconds);
  return true;
}

export async function clearSession(tenantId: string, phone: string): Promise<void> {
  const key = sessionKey(tenantId, phone);
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.del(key);
      return;
    }
  } catch (e: any) {
    console.warn("[chatSession] redis del failed:", e?.message);
  }
  if (isProd) return;
  memoryDel(key);
}
