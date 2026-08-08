/**
 * WhatsApp messaging-quality monitor.
 *
 * Meta grades each phone number (quality_rating GREEN/YELLOW/RED) and caps
 * throughput by messaging tier. We poll the Cloud API
 *   GET /{phoneNumberId}?fields=quality_rating,throughput
 * (daily cron via /api/scheduled/wa-quality-refresh) and cache the result in
 * tenants.settings.waQuality = { rating, tier, checkedAt, lastError? }.
 *
 * Meta quality_rating is mapped to a coarse HIGH/MEDIUM/LOW rating that the
 * broadcast throttle consumes: LOW blocks broadcast sends outright; MEDIUM
 * halves the per-minute send rate. When the API denies the lookup (missing
 * permission, network error) the previous cached value is kept and the
 * throttle degrades OPEN — quality telemetry must never block sends on its
 * own failure.
 */

import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { resolveTenantWaCredentials } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type FetchFn = typeof fetch;

export type WaQualityRating = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface WaQuality {
  rating: WaQualityRating;
  tier: string | null;
  checkedAt: string;
  /** Set when the last refresh failed (previous values are kept). */
  lastError?: string;
}

/** Map Meta's quality_rating (GREEN/YELLOW/RED) to HIGH/MEDIUM/LOW. */
export function mapMetaQuality(raw: unknown): WaQualityRating {
  const v = typeof raw === "string" ? raw.toUpperCase() : "";
  if (v === "GREEN") return "HIGH";
  if (v === "YELLOW") return "MEDIUM";
  if (v === "RED") return "LOW";
  return "UNKNOWN";
}

/** Read the cached quality snapshot from tenant settings (null when absent). */
export function parseWaQuality(settings: unknown): WaQuality | null {
  const q = (settings as any)?.waQuality;
  if (!q || typeof q !== "object") return null;
  const rating = (["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const).includes(q.rating) ? q.rating : "UNKNOWN";
  return {
    rating,
    tier: typeof q.tier === "string" ? q.tier : null,
    checkedAt: typeof q.checkedAt === "string" ? q.checkedAt : "",
    ...(typeof q.lastError === "string" ? { lastError: q.lastError } : {}),
  };
}

/** Cached quality for a tenant (null when never checked). */
export async function getWaQuality(db: Db, tenantId: string): Promise<WaQuality | null> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  return parseWaQuality(tenant?.settings);
}

/**
 * Pull the live quality rating + messaging tier from Meta and cache it in
 * settings.waQuality. Graceful degradation: on any API/permission failure the
 * previous cached rating/tier are preserved and `lastError` is recorded.
 */
export async function refreshWaQuality(
  db: Db,
  tenantId: string,
  fetchFn: FetchFn = fetch,
): Promise<WaQuality | null> {
  const previous = await getWaQuality(db, tenantId);
  const checkedAt = new Date().toISOString();

  let next: WaQuality | null = null;
  try {
    const creds = await resolveTenantWaCredentials(tenantId);
    if (!creds) {
      next = {
        rating: previous?.rating ?? "UNKNOWN",
        tier: previous?.tier ?? null,
        checkedAt,
        lastError: "no WhatsApp credentials configured",
      };
    } else {
      const url =
        `https://graph.facebook.com/v21.0/${encodeURIComponent(creds.phoneNumberId)}` +
        `?fields=quality_rating,throughput,messaging_limit_tier`;
      const res = await fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        next = {
          rating: previous?.rating ?? "UNKNOWN",
          tier: previous?.tier ?? null,
          checkedAt,
          lastError: `Graph API ${res.status}: ${body.slice(0, 200)}`,
        };
      } else {
        const data = (await res.json().catch(() => ({}))) as any;
        const tier =
          (typeof data?.messaging_limit_tier === "string" && data.messaging_limit_tier) ||
          (typeof data?.throughput?.level === "string" && data.throughput.level) ||
          null;
        next = { rating: mapMetaQuality(data?.quality_rating), tier, checkedAt };
      }
    }
  } catch (err: any) {
    next = {
      rating: previous?.rating ?? "UNKNOWN",
      tier: previous?.tier ?? null,
      checkedAt,
      lastError: String(err?.message ?? err).slice(0, 200),
    };
  }

  try {
    await db
      .update(tenants)
      .set({ settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({ waQuality: next })}::jsonb`, updatedAt: new Date() } as any)
      .where(eq(tenants.id, tenantId));
  } catch (err: any) {
    console.error("[waQuality] settings persist failed:", err?.message);
  }
  return next;
}

export interface QualityThrottle {
  blocked: boolean;
  reason?: string;
  ratePerMin: number;
}

/**
 * Broadcast throttle from the cached quality rating:
 *   LOW    → block the broadcast send entirely;
 *   MEDIUM → halve the per-minute rate (floor 1/min);
 *   anything else (incl. never-checked / errored) → unchanged.
 */
export function applyQualityThrottle(settings: unknown, ratePerMin: number): QualityThrottle {
  const q = parseWaQuality(settings);
  if (!q) return { blocked: false, ratePerMin };
  if (q.rating === "LOW") {
    return {
      blocked: true,
      reason:
        "Broadcast blocked: Meta reports a LOW WhatsApp quality rating for this number. " +
        "Improve message quality (fewer blocks/reports) and wait for the rating to recover before broadcasting.",
      ratePerMin,
    };
  }
  if (q.rating === "MEDIUM") {
    return { blocked: false, ratePerMin: Math.max(1, Math.floor(ratePerMin / 2)) };
  }
  return { blocked: false, ratePerMin };
}
