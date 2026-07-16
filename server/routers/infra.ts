/**
 * infra.ts — Infrastructure health router
 *
 * Provides a single `infraHealth` query that pings all 12 infrastructure
 * services in parallel and returns their online/latency status.
 *
 * Services checked:
 *   1.  Postgres          — via db.execute("SELECT 1")
 *   2.  Redis             — via GET /health on redis.ts helper
 *   3.  Kafka             — via kafka.ts health()
 *   4.  TigerBeetle       — via ledger-bridge /health
 *   5.  Mojaloop          — via mojaloop simulator /health
 *   6.  APISIX            — via Admin API GET /apisix/admin/routes
 *   7.  Keycloak          — via JWKS endpoint
 *   8.  OpenAppSec        — via management API /health
 *   9.  Permify           — via /healthz
 *   10. OpenSearch        — via /_cluster/health
 *   11. Fluvio            — via fluvio-consumer /health
 *   12. Dapr              — via sidecar /v1.0/healthz
 */
import { router, protectedProcedure } from "../_core/trpc";
import { ENV } from "../_core/env";
import { getDb } from "../db";

type ServiceStatus = {
  online: boolean;
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
};

async function ping(
  url: string,
  timeoutMs = 3000,
  headers: Record<string, string> = {},
): Promise<ServiceStatus> {
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - t0;
    let details: Record<string, unknown> | undefined;
    try {
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        details = await resp.json();
      }
    } catch (_) {}
    return { online: resp.ok, latencyMs, details };
  } catch (e: any) {
    return { online: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

async function checkPostgres(): Promise<ServiceStatus> {
  const t0 = Date.now();
  try {
    const db = await getDb();
    if (!db) return { online: false, latencyMs: 0, error: "db_unavailable" };
    await db.execute("SELECT 1" as any);
    return { online: true, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { online: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  const t0 = Date.now();
  try {
    const { redisHealthCheck } = await import("../redis");
    const result = await redisHealthCheck();
    return { online: result.online, latencyMs: Date.now() - t0, details: result as any };
  } catch (e: any) {
    return { online: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

async function checkKafka(): Promise<ServiceStatus> {
  const t0 = Date.now();
  try {
    const { kafkaHealthCheck } = await import("../kafka");
    const result = await kafkaHealthCheck();
    return { online: result.online, latencyMs: Date.now() - t0, details: result as any };
  } catch (e: any) {
    return { online: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

export const infraRouter = router({
  infraHealth: protectedProcedure.query(async () => {
    const [
      postgres,
      redis,
      kafka,
      tigerBeetle,
      mojaloop,
      apisix,
      keycloak,
      openappsec,
      permify,
      opensearch,
      fluvio,
      dapr,
    ] = await Promise.all([
      checkPostgres(),
      checkRedis(),
      checkKafka(),
      // TigerBeetle via ledger-bridge /health
      ping(`${ENV.ledgerBridgeHealthUrl}/health`),
      // Mojaloop simulator
      ping(`${ENV.mojaloopUrl}/health`),
      // APISIX Admin API
      ENV.apisixAdminKey
        ? ping(`${ENV.apisixAdminUrl}/apisix/admin/routes`, 3000, { "X-API-KEY": ENV.apisixAdminKey })
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      // Keycloak JWKS endpoint
      ping(`${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/certs`),
      // OpenAppSec management API
      ENV.openappsecUrl
        ? ping(`${ENV.openappsecUrl}/api/v1/health`, 3000, ENV.openappsecToken ? { Authorization: `Bearer ${ENV.openappsecToken}` } : {})
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      // Permify
      ENV.permifyUrl
        ? ping(`${ENV.permifyUrl}/healthz`)
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      // OpenSearch cluster health
      ENV.opensearchUrl
        ? ping(`${ENV.opensearchUrl}/_cluster/health`, 3000, {
            Authorization: "Basic " + Buffer.from(`${ENV.opensearchUser}:${ENV.opensearchPass}`).toString("base64"),
          })
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      // Fluvio consumer sidecar
      ping(`${ENV.fluvioConsumerUrl}/health`),
      // Dapr sidecar
      ping(`http://localhost:${ENV.daprHttpPort}/v1.0/healthz`),
    ]);

    return {
      checkedAt: Date.now(),
      services: {
        postgres,
        redis,
        kafka,
        tigerBeetle,
        mojaloop,
        apisix,
        keycloak,
        openappsec,
        permify,
        opensearch,
        fluvio,
        dapr,
      },
    };
  }),
});
