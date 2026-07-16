/**
 * server/redis.ts — Shared Redis client module
 *
 * Uses ioredis for session cache, rate limiting, pub/sub, and conversation state.
 * Falls back gracefully when REDIS_URL is not configured (local dev without Redis).
 *
 * Usage:
 *   import { getRedis, redisSet, redisGet, redisDel, redisIncrEx } from "./redis";
 */
import type Redis from "ioredis";
type RedisType = InstanceType<typeof Redis>;

let _redis: RedisType | null = null;
let _connectAttempted = false;

export async function getRedis(): Promise<RedisType | null> {
  if (_redis) return _redis;
  if (_connectAttempted) return null;
  _connectAttempted = true;

  const url = process.env.REDIS_URL ?? process.env.REDIS_TLS_URL ?? "";
  if (!url) {
    console.info("[Redis] REDIS_URL not set — Redis features disabled");
    return null;
  }

  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: true,
      enableOfflineQueue: false,
      tls: url.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    client.on("error", (err: Error) => console.warn("[Redis] connection error:", err.message));
    _redis = client;
    console.info("[Redis] Connected");
    return _redis;
  } catch (err: any) {
    console.warn("[Redis] Failed to connect:", err.message);
    return null;
  }
}

/** Set a key with optional TTL in seconds */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const r = await getRedis();
  if (!r) return;
  if (ttlSeconds) await r.setex(key, ttlSeconds, value);
  else await r.set(key, value);
}

/** Get a key value */
export async function redisGet(key: string): Promise<string | null> {
  const r = await getRedis();
  if (!r) return null;
  return r.get(key);
}

/** Delete a key */
export async function redisDel(key: string): Promise<void> {
  const r = await getRedis();
  if (!r) return;
  await r.del(key);
}

/**
 * Increment a counter and set TTL on first increment.
 * Used for per-tenant rate limiting.
 * Returns the new count.
 */
export async function redisIncrEx(key: string, ttlSeconds: number): Promise<number> {
  const r = await getRedis();
  if (!r) return 0;
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, ttlSeconds);
  return count;
}

/**
 * Store conversation context for a WhatsApp session.
 * TTL: 30 minutes of inactivity.
 */
export async function setConversationContext(tenantId: string, phone: string, ctx: object): Promise<void> {
  const key = `wa:ctx:${tenantId}:${phone}`;
  await redisSet(key, JSON.stringify(ctx), 1800);
}

export async function getConversationContext(tenantId: string, phone: string): Promise<Record<string, unknown> | null> {
  const key = `wa:ctx:${tenantId}:${phone}`;
  const raw = await redisGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Health check — returns latency in ms or null if unavailable */
export async function redisHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  try {
    const r = await getRedis();
    if (!r) return { online: false, error: "not_configured" };
    const t0 = Date.now();
    await r.ping();
    return { online: true, latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}
