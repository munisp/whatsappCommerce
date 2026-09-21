/**
 * Deep readiness probe (GET /health/ready).
 *
 * Unlike the lightweight /health liveness probe, readiness performs LIVE
 * checks against every hard dependency:
 *   - db          → SELECT 1 through the shared Drizzle pool
 *   - redis       → PING through the shared ioredis client
 *   - keycloak    → JWKS fetch (≤2s timeout) — proves the IdP serves tokens
 *   - tigerbeetle → ledger-bridge /health probe (≤2s). NEVER gating: an
 *                   unreachable bridge, a non-2xx reply, or a bridge that
 *                   reports TigerBeetle/Postgres down are all flagged
 *                   `degraded` (see checkTigerBeetle)
 *
 * Each component reports { ok, latencyMs, error? }. In production any failing
 * (ok:false) component flips the endpoint to 503 so the load balancer drains
 * the instance; in dev/test the endpoint stays 200 with per-component detail
 * (local dev must not require the full stack). `degraded` components stay
 * ok:true and are surfaced, not gated.
 */

import { sql } from "drizzle-orm";
// === W34 otel-core === traceparent propagation on readiness probes.
import { injectTraceHeaders } from "../_core/telemetry";
import { getDb } from "../db";
import { getRedis } from "../redis";
import { ENV } from "../_core/env";

export interface ComponentCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** The dependency is unavailable but the pod can still serve everything
   *  else. Reported, never gating — see checkTigerBeetle. `ok` stays true so
   *  the pod is not drained. */
  degraded?: boolean;
}

export interface OdooB2bOutboxCheck extends ComponentCheck {
  /** Pending outbound b2b events (odoo system, b2b entity kinds). */
  pending?: number;
  /** Age in seconds of the OLDEST pending b2b event (null when none). */
  lagSeconds?: number | null;
}

export interface ReadinessReport {
  ok: boolean;
  components: {
    db: ComponentCheck;
    redis: ComponentCheck;
    keycloak: ComponentCheck;
    tigerbeetle: ComponentCheck;
    odooB2bOutbox: OdooB2bOutboxCheck;
    /** === W46 platform-p2 (PLT-18) === Kafka reconnect state probe. */
    kafka: ComponentCheck;
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
  // The ledger is a SHARED dependency: every server replica talks to the same
  // ledger-bridge Service. Readiness exists to drain a pod that is individually
  // broken; failing it on a shared dependency drains ALL pods at once, turning
  // a payments-only outage into a total one (measured on the live cluster,
  // CX-02: bridge restarted → 0 Service endpoints → every server pod unready →
  // 28 s of 503s on every route, including catalog, auth and webhooks).
  //
  // So this check is NON-GATING in every branch. The documented design
  // (docs/RESILIENCE.md, pinned by ledgerOutage.test.ts) is graceful
  // degradation: payment initiation fails honestly (intent marked failed with
  // ledger_failed, error surfaced — an unreachable bridge is covered too) and
  // everything else keeps serving. The outage is still visible: it is reported
  // here as `degraded`, and the separate infra_component_up{component=
  // "tigerBeetle"} gauge (probed every 60s) drives the ComponentDown alert.
  // (The live cluster has run in the "reachable but TigerBeetle/Postgres down"
  // state all along; the bridge's own /health always answers 200 and carries
  // per-dependency booleans in its body.)
  const degraded = (error: string): ComponentCheck => ({
    ok: true,
    degraded: true,
    latencyMs: Date.now() - t0,
    error: `degraded: ${error}`,
  });
  try {
    const res = await fetch(`${ENV.ledgerBridgeUrl}/health`, { headers: injectTraceHeaders({}), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => null); // W34 otel-core: traceparent
    if (!res?.ok) return degraded(`ledger-bridge ${res ? `returned ${res.status}` : "unreachable"}`);
    let body: any = null;
    try { body = await res.json(); } catch { /* body is optional detail */ }
    const down = [
      body?.tigerbeetle?.healthy === false && "tigerbeetle",
      body?.postgres?.healthy === false && "postgres",
    ].filter(Boolean) as string[];
    if (down.length > 0) return degraded(`ledger-bridge cannot reach ${down.join(" + ")}`);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return degraded(String(err?.message ?? err));
  }
}

/**
 * Odoo B2B outbox lag (w8): pending count + age of the oldest undelivered
 * outbound event for the b2b entity kinds (purchase_order, supplier,
 * credit_repayment) on the odoo system. A growing lag means the supplier-ERP
 * sync pipeline is backed up or DLQ-ing.
 */
async function checkOdooB2bOutbox(): Promise<OdooB2bOutboxCheck> {
  const t0 = Date.now();
  try {
    const db = await getDb();
    if (!db) return { ok: false, latencyMs: Date.now() - t0, error: "db_unavailable" };
    const res: any = await db.execute(sql`
      SELECT count(*)::int AS pending,
             EXTRACT(EPOCH FROM (now() - min("createdAt")))::float AS lag_seconds
      FROM integration_events
      WHERE direction = 'out'
        AND status = 'pending'
        AND system = 'odoo'
        AND entity IN ('purchase_order', 'supplier', 'credit_repayment')
    `);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    const row = rows[0] ?? {};
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      pending: Number(row.pending ?? 0),
      lagSeconds: row.lag_seconds == null ? null : Number(row.lag_seconds),
    };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}

/** HTTP status for /health/ready: 503 on any failure in production, 200 in dev/test. */
export function readinessHttpStatus(report: ReadinessReport, production: boolean): number {
  return !report.ok && production ? 503 : 200;
}

/**
 * === W46 platform-p2 (PLT-18) === Kafka readiness: reports the reconnect
 * state machine (backoff/jitter, latch resets). Kafka is an OPTIONAL dep —
 * unconfigured counts ok; configured-but-failing counts NOT ok so a wedged
 * producer drains the pod in production.
 */
async function checkKafka(): Promise<ComponentCheck> {
  const t0 = Date.now();
  try {
    const { getKafkaConnectionState } = await import("../kafka");
    const state = getKafkaConnectionState();
    if (!state.configured) return { ok: true, latencyMs: Date.now() - t0, error: "not_configured" };
    // Lazy connect: a configured-but-never-attempted producer is ok; only
    // actual connect failures (retrying) or a dropped connection fail.
    if (state.connected || state.consecutiveFailures === 0) {
      return { ok: true, latencyMs: Date.now() - t0 };
    }
    return { ok: false, latencyMs: Date.now() - t0, error: `kafka_disconnected (failures=${state.consecutiveFailures}, nextRetryAt=${state.nextRetryAt ?? "now"})` };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}
// === END W46 platform-p2 (PLT-18) ===

/** Run all component probes in parallel. */
export async function checkReadiness(): Promise<ReadinessReport> {
  const [db, redis, keycloak, tigerbeetle, odooB2bOutbox, kafka] = await Promise.all([
    checkDb(), checkRedis(), checkKeycloak(), checkTigerBeetle(), checkOdooB2bOutbox(), checkKafka(),
  ]);
  const components = { db, redis, keycloak, tigerbeetle, odooB2bOutbox, kafka };
  return { ok: Object.values(components).every(c => c.ok), components };
}
