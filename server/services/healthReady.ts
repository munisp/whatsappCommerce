/**
 * Deep readiness probe (GET /health/ready).
 *
 * Unlike the lightweight /health liveness probe, readiness performs LIVE
 * checks against every hard dependency:
 *   - db          → SELECT 1 through the shared Drizzle pool
 *   - redis       → PING through the shared ioredis client
 *   - keycloak    → JWKS fetch (≤2s timeout) — proves the IdP serves tokens
 *   - tigerbeetle → ledger-bridge /health probe (≤2s)
 *
 * Each component reports { ok, latencyMs, error? }. In production ANY failure
 * flips the endpoint to 503 so the load balancer drains the instance; in
 * dev/test the endpoint stays 200 with per-component detail (local dev must
 * not require the full stack).
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { getRedis } from "../redis";
import { ENV } from "../_core/env";

export interface ComponentCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  ok: boolean;
  components: {
    db: ComponentCheck;
    redis: ComponentCheck;
    keycloak: ComponentCheck;
    tigerbeetle: ComponentCheck;
  };
}

const PROBE_TIMEOUT_MS = 2000;

async function checkDb(): Promise<ComponentCheck> {
  const t0 = Date.now();
  try {
    const db = await getDb();
    if (!db) return { ok: false, latencyMs: Date.now() - t0, error: "db_unavailable" };
    await db.execute(sql`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}

async function checkRedis(): Promise<ComponentCheck> {
  const t0 = Date.now();
  try {
    const redis = await getRedis();
    if (!redis) return { ok: false, latencyMs: Date.now() - t0, error: "redis_not_connected" };
    const pong = await redis.ping();
    return pong === "PONG"
      ? { ok: true, latencyMs: Date.now() - t0 }
      : { ok: false, latencyMs: Date.now() - t0, error: `unexpected ping reply: ${pong}` };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}

async function checkKeycloak(): Promise<ComponentCheck> {
  const t0 = Date.now();
  try {
    const url = `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/certs`;
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => null);
    if (!res) return { ok: false, latencyMs: Date.now() - t0, error: "jwks_unreachable" };
    if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, error: `jwks_http_${res.status}` };
    const body: any = await res.json().catch(() => null);
    if (!Array.isArray(body?.keys)) return { ok: false, latencyMs: Date.now() - t0, error: "jwks_malformed" };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}

async function checkTigerBeetle(): Promise<ComponentCheck> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${ENV.ledgerBridgeUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => null);
    return res?.ok
      ? { ok: true, latencyMs: Date.now() - t0 }
      : { ok: false, latencyMs: Date.now() - t0, error: `ledger-bridge returned ${res?.status ?? "unreachable"}` };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}

/** HTTP status for /health/ready: 503 on any failure in production, 200 in dev/test. */
export function readinessHttpStatus(report: ReadinessReport, production: boolean): number {
  return !report.ok && production ? 503 : 200;
}

/** Run all component probes in parallel. */
export async function checkReadiness(): Promise<ReadinessReport> {
  const [db, redis, keycloak, tigerbeetle] = await Promise.all([
    checkDb(), checkRedis(), checkKeycloak(), checkTigerBeetle(),
  ]);
  const components = { db, redis, keycloak, tigerbeetle };
  return { ok: Object.values(components).every(c => c.ok), components };
}
