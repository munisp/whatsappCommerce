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

