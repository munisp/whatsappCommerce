// === W66 learning ===
/**
 * demandSignals.ts — R8(d) search zero-results → demand signals.
 *
 * Buyers searching and finding NOTHING is unmet demand. This service
 * aggregates zero-result search_queries per tenant over a trailing week:
 *
 *  - summarizeDemandSignals(db, tenantId): top zero-result queries with
 *    counts — rendered as the "buyers searched X, found nothing" insight
 *    card in MerchantDashboard (router: learning.demandSummary).
 *  - runDemandDigest (POST /api/scheduled/demand-digest, fires daily):
 *    per-tenant weekly WA/TG digest to the merchant admin. Idempotent via
 *    proactive_nudges claimed with the ISO-week Monday bucket — a daily
 *    re-fire in the same week sends 0.
 *
 * Fail-open everywhere; quiet hours honoured; i18n ×8 via MESSAGE_CATALOG.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { interpolate, getStickyLocale, t27 } from "./i18n";
import { isQuietHours, parseMarketingFrequencyPolicy } from "./frequencyCap";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const DEMAND_WINDOW_DAYS = 7;
export const DEMAND_MIN_COUNT = 2; // a query must recur to be "demand"

export interface DemandSignal {
  query: string;
  count: number;
}

/** Top zero-result queries for a tenant over the trailing window. */
export async function summarizeDemandSignals(
  db: Db,
  tenantId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<DemandSignal[]> {
  const days = opts.days ?? DEMAND_WINDOW_DAYS;
  const rows = await db.execute(sql`
    SELECT lower(trim(query)) AS q, count(*)::int AS n
    FROM search_queries
    WHERE tenant_id = ${tenantId}
      AND zero_result = true
      AND created_at > now() - (${days} * interval '1 day')
    GROUP BY lower(trim(query))
    ORDER BY n DESC
    LIMIT ${Math.min(50, opts.limit ?? 10)}
  `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
  return (rows as any[]).map((r) => ({ query: r.q, count: Number(r.n) }));
}

export interface DemandDigestRun {
  digestsSent: number;
  skippedQuiet: number;
  tenantsWithSignals: number;
}

/** Weekly merchant digest of unmet-demand queries. Never throws. */
export async function runDemandDigest(opts: { now?: Date } = {}): Promise<DemandDigestRun> {
  const out: DemandDigestRun = { digestsSent: 0, skippedQuiet: 0, tenantsWithSignals: 0 };
  try {
    const db = await getDb();
    if (!db) return out;
    const now = opts.now ?? new Date();
    // ISO-week Monday bucket — one digest per tenant per week even though
    // the scheduler fires daily.
    const monday = new Date(now);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const week = monday.toISOString().slice(0, 10);

    const tenantRows = await db.select({ id: tenants.id, settings: tenants.settings }).from(tenants)
      .catch(() => [] as any[]);
    for (const t of tenantRows as any[]) {
      try {
        const settings = ((t.settings ?? {}) as Record<string, unknown>);
        const adminPhone = typeof settings.adminPhone === "string" ? settings.adminPhone : "";
        if (!adminPhone) continue;
        const signals = (await summarizeDemandSignals(db, t.id)).filter((s) => s.count >= DEMAND_MIN_COUNT);
        if (signals.length === 0) continue;
        out.tenantsWithSignals += 1;
        if (isQuietHours(now, parseMarketingFrequencyPolicy(settings))) { out.skippedQuiet += 1; continue; }
        const res = await db.execute(sql`
          INSERT INTO proactive_nudges (tenant_id, nudge_type, subject_id, day, status)
          VALUES (${t.id}, 'demand_digest', ${t.id}, ${week}, 'claimed')
          ON CONFLICT (tenant_id, nudge_type, subject_id, day) DO NOTHING
          RETURNING id
        `).catch(() => null);
        const claimed = ((res as any)?.rows ?? res ?? []);
        if (!Array.isArray(claimed) || claimed.length !== 1) continue;
        const top = signals.slice(0, 3);
        const locale = (await getStickyLocale(t.id, adminPhone).catch(() => null)) ?? "en";
        const body = interpolate(t27(locale, "demandDigest"), {
          count: signals.reduce((s, x) => s + x.count, 0),
          queries: top.map((s) => `"${s.query}" ×${s.count}`).join(", "),
        });
        const { notifyCustomer } = await import("./channelParity");
        const tg = await notifyCustomer(t.id, adminPhone, "ops_alert", { text: body, notifType: "w66_demand_digest" }).catch(() => ({ handled: false }) as any);
        if (!(tg as any)?.handled) {
          const { sendWhatsAppText } = await import("./waSender");
          await sendWhatsAppText(t.id, adminPhone, body, { notifType: "w66_demand_digest" }).catch((e: any) =>
            console.warn("[demand] WA send failed (fail-open):", e?.message));
        }
        out.digestsSent += 1;
      } catch (e: any) {
        console.warn("[demand] tenant digest failed (fail-open):", e?.message);
      }
    }
  } catch (e: any) {
    console.error("[demand] digest sweep failed (fail-open):", e?.message);
  }
  return out;
}
// === END W66 learning ===
