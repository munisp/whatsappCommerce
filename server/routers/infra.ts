/**
 * server/routers/infra.ts — Infrastructure management tRPC router
 *
 * Provides procedures for:
 *   - Full infrastructure health checks (all 12+ services)
 *   - WAF event ingestion and listing (OpenAppSec)
 *   - Fluvio topic monitoring and event log
 *   - APISIX route management (CRUD + live sync)
 *   - Dapr event log
 *   - Lakehouse pipeline runs
 *   - TigerBeetle account management
 *   - Reconciliation trigger
 */
import { router, adminProcedure, protectedProcedure, internalProcedure } from "../_core/trpc";
import { z } from "zod";
import { getDb } from "../db";
import {
  openappsecWafEvents,
  fluvioEventLog,
  apisixRouteConfigs,
  daprEventLog,
  lakehousePipelineRuns,
  tigerBeetleAccounts,
} from "../../drizzle/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { ENV } from "../_core/env";
import { TRPCError } from "@trpc/server";
import { daprHealthCheck } from "../dapr";
import * as observability from "../services/observability";

// ── Health check helpers ──────────────────────────────────────────────────────

type ServiceStatus = { online: boolean; latencyMs: number; error?: string; details?: unknown };

async function ping(url: string, timeoutMs = 3000, headers: Record<string, string> = {}): Promise<ServiceStatus> {
  const t0 = Date.now();
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - t0;
    let details: unknown;
    try {
      if (resp.headers.get("content-type")?.includes("application/json")) details = await resp.json();
    } catch { /* ignore */ }
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
    await db.execute(sql`SELECT 1`);
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

// ── Router ────────────────────────────────────────────────────────────────────

export const infraRouter = router({

  // ── Full infrastructure health (original infraHealth + new services) ─────────
  infraHealth: protectedProcedure.query(async () => {
    const [
      postgres, redis, kafka, tigerBeetle, mojaloop,
      apisix, keycloak, openappsec, permify, opensearch,
      fluvio, dapr, temporal, mlStack, reconWorker,
    ] = await Promise.all([
      checkPostgres(),
      checkRedis(),
      checkKafka(),
      ping(`${ENV.ledgerBridgeHealthUrl}/health`),
      ping(`${ENV.mojaloopUrl}/health`),
      ENV.apisixAdminKey
        ? ping(`${ENV.apisixAdminUrl}/apisix/admin/routes`, 3000, { "X-API-KEY": ENV.apisixAdminKey })
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      ping(`${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/certs`),
      ENV.openappsecUrl
        ? ping(`${ENV.openappsecUrl}/api/v1/health`, 3000, ENV.openappsecToken ? { Authorization: `Bearer ${ENV.openappsecToken}` } : {})
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      ENV.permifyUrl
        ? ping(`${ENV.permifyUrl}/healthz`)
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      ENV.opensearchUrl
        ? ping(`${ENV.opensearchUrl}/_cluster/health`, 3000, {
            Authorization: "Basic " + Buffer.from(`${ENV.opensearchUser}:${ENV.opensearchPass}`).toString("base64"),
          })
        : Promise.resolve({ online: false, latencyMs: 0, error: "not_configured" } as ServiceStatus),
      ping(`${ENV.fluvioConsumerUrl}/health`),
      daprHealthCheck(),
      ping(`${ENV.appUrl}/api/health/temporal`).catch(() => ({ online: false, latencyMs: 0, error: "not_configured" })),
      ping(`${ENV.mlStackUrl}/health`).catch(() => ({ online: false, latencyMs: 0, error: "not_configured" })),
      ping(`${ENV.reconWorkerUrl}/health`).catch(() => ({ online: false, latencyMs: 0, error: "not_configured" })),
    ]);
    return {
      checkedAt: Date.now(),
      services: {
        postgres, redis, kafka, tigerBeetle, mojaloop,
        apisix, keycloak, openappsec, permify, opensearch,
        fluvio, dapr, temporal, mlStack, reconWorker,
      },
    };
  }),

  // ── WAF Events ──────────────────────────────────────────────────────────────
  recordWafEvent: internalProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
      attackType: z.string().optional(),
      sourceIp: z.string().optional(),
      requestUri: z.string().optional(),
      method: z.string().optional(),
      userAgent: z.string().optional(),
      blocked: z.boolean().default(true),
      rawEvent: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { recorded: false };
      await db.insert(openappsecWafEvents).values({
        tenantId: input.tenantId,
        severity: input.severity,
        attackType: input.attackType,
        sourceIp: input.sourceIp,
        requestUri: input.requestUri,
        method: input.method,
        userAgent: input.userAgent,
        blocked: input.blocked,
        rawEvent: input.rawEvent,
        detectedAt: new Date(),
      });
      return { recorded: true };
    }),

  /**
   * Admin: recent captured errors (w10 observability ring buffer, newest
   * first). Sourced from the in-process ring buffer in
   * server/services/observability.ts — per-instance, last 200 captures.
   */
  systemRecentErrors: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(200).default(50),
    }).optional())
    .query(({ input }) => {
      const { getRecentErrors } = observability;
      return { errors: getRecentErrors(input?.limit ?? 50), capacity: 200 };
    }),

  listWafEvents: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
      sinceHours: z.number().int().min(1).max(720).default(24),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { events: [], total: 0 };
      const since = new Date(Date.now() - input.sinceHours * 3600 * 1000);
      const conditions: any[] = [gte(openappsecWafEvents.detectedAt, since)];
      if (input.tenantId) conditions.push(eq(openappsecWafEvents.tenantId, input.tenantId));
      if (input.severity) conditions.push(eq(openappsecWafEvents.severity, input.severity));
      const events = await db.select().from(openappsecWafEvents)
        .where(and(...conditions)).orderBy(desc(openappsecWafEvents.detectedAt)).limit(input.limit);
      return { events, total: events.length };
    }),

  // ── Fluvio Event Log ─────────────────────────────────────────────────────────
  recordFluvioEvent: internalProcedure
    .input(z.object({
      topic: z.string(),
      offset: z.number().int(),
      partition: z.number().int().default(0),
      tenantId: z.string().optional(),
      eventType: z.string().optional(),
      payload: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { recorded: false };
      await db.insert(fluvioEventLog).values({
        topic: input.topic, offset: input.offset, partition: input.partition,
        tenantId: input.tenantId, eventType: input.eventType,
        payload: input.payload, processed: false, receivedAt: new Date(),
      });
      return { recorded: true };
    }),

  listFluvioEvents: adminProcedure
    .input(z.object({
      topic: z.string().optional(),
      processed: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { events: [], total: 0 };
      const conditions: any[] = [];
      if (input.topic) conditions.push(eq(fluvioEventLog.topic, input.topic));
      if (input.processed !== undefined) conditions.push(eq(fluvioEventLog.processed, input.processed));
      const events = await db.select().from(fluvioEventLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(fluvioEventLog.receivedAt)).limit(input.limit);
      return { events, total: events.length };
    }),

  // ── APISIX Route Management ──────────────────────────────────────────────────
  listApisixRoutes: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      status: z.enum(["active", "inactive", "draft"]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { routes: [] };
      const conditions: any[] = [];
      if (input.tenantId) conditions.push(eq(apisixRouteConfigs.tenantId, input.tenantId));
      if (input.status) conditions.push(eq(apisixRouteConfigs.status, input.status));
      const routes = await db.select().from(apisixRouteConfigs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(apisixRouteConfigs.createdAt));
      return { routes };
    }),

  upsertApisixRoute: adminProcedure
    .input(z.object({
      routeId: z.string(),
      tenantId: z.string().optional(),
      name: z.string(),
      uri: z.string(),
      methods: z.array(z.string()),
      upstreamUrl: z.string(),
      plugins: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(["active", "inactive", "draft"]).default("active"),
      rateLimitRpm: z.number().int().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      let apisixSynced = false;
      if (ENV.apisixAdminKey) {
        try {
          const res = await fetch(`${ENV.apisixAdminUrl}/apisix/admin/routes/${input.routeId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-API-KEY": ENV.apisixAdminKey },
            body: JSON.stringify({
              id: input.routeId, name: input.name, uri: input.uri, methods: input.methods,
              upstream: { type: "roundrobin", nodes: { [input.upstreamUrl]: 1 } },
              plugins: input.plugins ?? {}, status: input.status === "active" ? 1 : 0,
            }),
            signal: AbortSignal.timeout(5000),
          });
          apisixSynced = res.ok;
        } catch (e) { console.warn("[APISIX] Route sync failed:", e); }
      }
      await db.insert(apisixRouteConfigs).values({
        routeId: input.routeId, tenantId: input.tenantId, name: input.name,
        uri: input.uri, methods: input.methods, upstreamUrl: input.upstreamUrl,
        plugins: input.plugins, status: input.status, rateLimitRpm: input.rateLimitRpm,
        apisixSynced, lastSyncedAt: apisixSynced ? new Date() : undefined,
        createdAt: new Date(), updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: apisixRouteConfigs.routeId,
        set: {
          name: input.name, uri: input.uri, methods: input.methods,
          upstreamUrl: input.upstreamUrl, plugins: input.plugins, status: input.status,
          rateLimitRpm: input.rateLimitRpm, apisixSynced,
          lastSyncedAt: apisixSynced ? new Date() : undefined, updatedAt: new Date(),
        },
      });
      return { routeId: input.routeId, apisixSynced };
    }),

  // ── Dapr Event Log ───────────────────────────────────────────────────────────
  listDaprEvents: adminProcedure
    .input(z.object({
      topic: z.string().optional(),
      status: z.enum(["published", "failed", "retrying"]).optional(),
      sinceHours: z.number().int().min(1).max(720).default(24),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { events: [], total: 0 };
      const since = new Date(Date.now() - input.sinceHours * 3600 * 1000);
      const conditions: any[] = [gte(daprEventLog.publishedAt, since)];
      if (input.topic) conditions.push(eq(daprEventLog.topic, input.topic));
      if (input.status) conditions.push(eq(daprEventLog.status, input.status));
      const events = await db.select().from(daprEventLog)
        .where(and(...conditions)).orderBy(desc(daprEventLog.publishedAt)).limit(input.limit);
      return { events, total: events.length };
    }),

  // ── Lakehouse Pipeline Runs ──────────────────────────────────────────────────
  listLakehouseRuns: adminProcedure
    .input(z.object({
      pipelineType: z.string().optional(),
      status: z.enum(["running", "completed", "failed", "partial"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { runs: [] };
      const conditions: any[] = [];
      if (input.pipelineType) conditions.push(eq(lakehousePipelineRuns.pipelineType, input.pipelineType));
      if (input.status) conditions.push(eq(lakehousePipelineRuns.status, input.status));
      const runs = await db.select().from(lakehousePipelineRuns)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(lakehousePipelineRuns.startedAt)).limit(input.limit);
      return { runs };
    }),

  triggerLakehousePipeline: adminProcedure
    .input(z.object({
      pipelineType: z.enum(["etl", "feature_engineering", "model_training", "full"]),
      tenantId: z.string().optional(),
      force: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const mlStackUrl = ENV.mlStackUrl;
      try {
        const res = await fetch(`${mlStackUrl}/lakehouse/trigger`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return res.json();
      } catch (e) { console.warn("[Lakehouse] Trigger failed:", e); }
      const db = await getDb();
      if (db) {
        const [run] = await db.insert(lakehousePipelineRuns).values({
          pipelineType: input.pipelineType, stage: "triggered", status: "running",
          metadata: { tenantId: input.tenantId, force: input.force }, startedAt: new Date(),
        }).returning();
        return { run_id: run.id, pipeline_type: input.pipelineType, status: "triggered" };
      }
      return { status: "failed", error: "db_unavailable" };
    }),

  // ── TigerBeetle Account Management ──────────────────────────────────────────
  provisionTbAccount: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      accountType: z.enum(["merchant", "escrow", "platform_fee", "float", "suspense"]),
      currency: z.string().default("NGN"),
    }))
    .mutation(async ({ input }) => {
      try {
        const res = await fetch(`${ENV.ledgerBridgeUrl}/accounts/provision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return res.json();
      } catch (e) { console.warn("[TigerBeetle] Provision failed:", e); }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Ledger bridge unavailable" });
    }),

  listTbAccounts: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      accountType: z.enum(["merchant", "escrow", "platform_fee", "float", "suspense"]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { accounts: [] };
      const conditions: any[] = [];
      if (input.tenantId) conditions.push(eq(tigerBeetleAccounts.tenantId, input.tenantId));
      if (input.accountType) conditions.push(eq(tigerBeetleAccounts.accountType, input.accountType));
      const accounts = await db.select().from(tigerBeetleAccounts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tigerBeetleAccounts.createdAt));
      return { accounts };
    }),

  // ── Reconciliation ───────────────────────────────────────────────────────────
  triggerReconciliation: adminProcedure.mutation(async () => {
    // W30 (V3#8): fail loudly with an actionable setup hint — a dead recon
    // button must tell the operator WHY and how to fix the wiring.
    if (!process.env.RECON_WORKER_URL) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "recon worker not configured: set RECON_WORKER_URL on the platform " +
          "service (compose default: http://recon-worker:8096; k8s: " +
          "http://recon-worker.whatsapp-commerce.svc.cluster.local:8096) " +
          "and ensure the recon-worker service is running.",
      });
    }
    let lastError: string | null = null;
    try {
      const res = await fetch(`${ENV.reconWorkerUrl}/recon/trigger`, {
        method: "POST", signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res.json();
      lastError = `recon-worker responded HTTP ${res.status}`;
    } catch (e) {
      lastError = String((e as Error)?.message ?? e);
      console.warn("[Recon] Trigger failed:", e);
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `reconciliation trigger failed: recon-worker unreachable at ${ENV.reconWorkerUrl} (${lastError}). Check that the recon-worker service is up and RECON_WORKER_URL points at it.`,
    });
  }),

  getLastReconciliation: adminProcedure.query(async () => {
    try {
      const res = await fetch(`${ENV.reconWorkerUrl}/recon/last`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return res.json();
    } catch { /* ignore */ }
    return { status: "no_runs_yet" };
  }),

  // ── Reconciliation run recording (called by recon-worker) ───────────────────
  recordReconRun: internalProcedure
    .input(z.object({
      runId: z.string(),
      discrepancies: z.number().int(),
      alerts: z.array(z.object({
        severity: z.string(),
        message: z.string(),
        tenantId: z.string().optional(),
        amountDiff: z.number().optional(),
      })),
    }))
    .mutation(async ({ input }) => {
      // Log to dapr event log for observability
      const db = await getDb();
      if (db) {
        await db.insert(daprEventLog).values({
          pubsubName: "internal",
          topic: "wacommerce.recon.completed",
          eventType: "recon_completed",
          payload: { runId: input.runId, discrepancies: input.discrepancies, alerts: input.alerts },
          status: "published",
          publishedAt: new Date(),
        }).catch(() => null);
      }
      return { recorded: true };
    }),
});
