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
  const value = JSON.stringify({ ...session, updatedAt: Date.now() });
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
