/**
 * server/routers/apisix.ts — APISIX API Gateway management router
 *
 * Provides tRPC procedures to:
 *   - List, create, update, delete APISIX routes
 *   - Sync routes to the live APISIX Admin API
 *   - View route health and traffic stats
 *   - Manage per-tenant rate limits
 */
import { z } from "zod";
import { router, adminProcedure, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { apisixRouteConfigs } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { ENV } from "../_core/env";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";

// ── APISIX Admin API helpers ──────────────────────────────────────────────────

const APISIX_ADMIN = () => ENV.apisixAdminUrl ?? "http://apisix:9180";
const APISIX_KEY = () => ENV.apisixAdminKey ?? "";

async function apisixRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!APISIX_KEY()) {
    return { ok: false, error: "APISIX_ADMIN_KEY not configured" };
  }
  try {
    const res = await fetch(`${APISIX_ADMIN()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": APISIX_KEY(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: `APISIX ${method} ${path} → ${res.status}: ${JSON.stringify(data)}` };
    }
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── tRPC router ───────────────────────────────────────────────────────────────

export const apisixRouter = router({
  /** List routes directly from the live APISIX Admin API. */
  listLive: adminProcedure.query(async () => {
    const res = await apisixRequest("GET", "/apisix/admin/routes");
    if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: res.error });
    return res.data;
  }),

  /** Delete a route from live APISIX and mark it deleted in the DB mirror. */
  deleteRoute: adminProcedure
    .input(z.object({ routeId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const res = await apisixRequest("DELETE", `/apisix/admin/routes/${input.routeId}`);
      if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: res.error });
      const db = await getDb();
      if (db) {
        await db
          .update(apisixRouteConfigs)
          .set({ status: "inactive", updatedAt: new Date() })
          .where(eq(apisixRouteConfigs.routeId, input.routeId));
      }
      return { routeId: input.routeId, deleted: true };
    }),

  /** Push all active DB-mirrored routes to the live APISIX Admin API. */
  syncAll: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const routes = await db
      .select()
      .from(apisixRouteConfigs)
      .where(eq(apisixRouteConfigs.status, "active"));
    const results: Array<{ routeId: string; synced: boolean; error?: string }> = [];
    for (const r of routes) {
      const upstream = new URL(r.upstreamUrl);
      const plugins: Record<string, unknown> = { ...((r.plugins as Record<string, unknown>) ?? {}) };
      if (r.rateLimitRpm) {
        plugins["limit-req"] = { rate: r.rateLimitRpm / 60, burst: r.rateLimitRpm, rejected_code: 429 };
      }
      const res = await apisixRequest("PUT", `/apisix/admin/routes/${r.routeId}`, {
        name: r.name,
        uri: r.uri,
        methods: r.methods ?? ["GET"],
        upstream: {
          type: "roundrobin",
          nodes: { [`${upstream.hostname}:${upstream.port || 80}`]: 1 },
        },
        plugins,
      });
      results.push({ routeId: r.routeId, synced: res.ok, error: res.error });
      await db
        .update(apisixRouteConfigs)
        .set({ apisixSynced: res.ok, lastSyncedAt: res.ok ? new Date() : undefined, updatedAt: new Date() })
        .where(eq(apisixRouteConfigs.routeId, r.routeId));
    }
    return { total: routes.length, synced: results.filter((x) => x.synced).length, results };
  }),

  /** Health of the APISIX Admin API itself. */
  health: protectedProcedure.query(async () => {
    if (!APISIX_KEY()) return { configured: false, reachable: false };
    const res = await apisixRequest("GET", "/apisix/admin/routes");
    return { configured: true, reachable: res.ok, error: res.error };
  }),
});
