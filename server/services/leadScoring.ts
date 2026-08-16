/**
 * server/services/leadScoring.ts — W17 F11 CRM depth on top of Twenty.
 *
 * Commerce-native lead scoring: Twenty stays the CRM system of record, but
 * Twenty never sees our WhatsApp commerce events (orders, trade-credit
 * repayment behavior, broadcast replies). This service turns those signals
 * into an explainable 0–100 lead score per customer:
 *
 *   RFM (from our order book):
 *     recency   ≤7d +25, ≤30d +15, ≤90d +5
 *     frequency orders in the last 90d, +5 each, capped +25
 *     monetary  lifetime value bands, capped +20
 *   Credit behavior (our moat — trade-credit ledger):
 *     any on-time repayment history +15
 *     any late repayment −10
 *     active default (overdue unsettled draw) −25
 *     healthy utilization band (has limit, ≤70% drawn) +5
 *   Engagement:
 *     replied within 24h to the last broadcast +5
 *     WhatsApp inbound activity within 7d +5
 *
 * computeLeadScore is a PURE function — every delta is listed in `factors`
 * so the merchant can see exactly why a customer is hot/warm/cold.
 * refreshLeadScores(tenantId) collects the signals per customer and upserts
 * into customer_lead_scores (unique tenantId+customerId). All tunables live
 * in LEAD_SCORE_WEIGHTS for testability.
 *
 * Optional Twenty push: syncScoreToTwenty is fire-and-forget and gated by
 * CRM_SYNC_ENABLED; the fetch seam is injectable for tests.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  broadcastRecipients,
  broadcastCampaigns,
  whatsappCustomerReplies,
  creditAccounts,
  creditLedger,
  customerLeadScores,
  customers,
  orders,
  purchaseOrders,
} from "../../drizzle/schema";

export type LeadBand = "hot" | "warm" | "cold";
export type LeadStage =
  | "new_lead"
  | "engaged"
  | "first_order"
  | "repeat"
  | "vip"
  | "at_risk";

export interface LeadScoreFactor {
  factor: string;
  delta: number;
}

export interface LeadScoreSignals {
  /** Days since the customer's most recent order (null = never ordered). */
  daysSinceLastOrder: number | null;
  /** Orders placed in the last 90 days. */
  ordersLast90d: number;
  /** Lifetime order count. */
  totalOrders: number;
  /** Lifetime order value (major currency units). */
  totalSpent: number;
  /** Customer has at least one on-time trade-credit repayment. */
  hasOnTimeRepayment: boolean;
  /** Customer has at least one late trade-credit repayment. */
  hasLateRepayment: boolean;
  /** Customer has an overdue, unsettled credit draw right now. */
  hasActiveDefault: boolean;
  /** Credit limit in cents (0/null = no credit facility). */
  creditLimitCents: number | null;
  /** Outstanding credit in cents. */
  creditOutstandingCents: number | null;
  /** Replied within 24h to the tenant's most recent broadcast to them. */
  repliedToLastBroadcastWithin24h: boolean;
  /** Days since last inbound WhatsApp message (null = never). */
  daysSinceLastWhatsAppActivity: number | null;
}

/** All scoring tunables in one place (tests import this, never hardcode). */
export const LEAD_SCORE_WEIGHTS = {
  recency: {
    within7d: 25,
    within30d: 15,
    within90d: 5,
  },
  frequency: {
    perOrderLast90d: 5,
    cap: 25,
  },
  monetary: {
    /** [threshold, points] bands, evaluated high → low; capped at `cap`. */
    bands: [
      { minSpent: 100_000, points: 20 },
      { minSpent: 25_000, points: 15 },
      { minSpent: 5_000, points: 10 },
      { minSpent: 1, points: 5 },
    ] as { minSpent: number; points: number }[],
    cap: 20,
  },
  credit: {
    onTimeRepayment: 15,
    lateRepayment: -10,
    activeDefault: -25,
    healthyUtilization: 5,
    /** Utilization at or below this ratio counts as healthy. */
    healthyUtilizationMaxRatio: 0.7,
  },
  engagement: {
    repliedWithin24hToLastBroadcast: 5,
    whatsAppActiveWithin7d: 5,
  },
  bands: {
    hotMin: 70,
    warmMin: 40,
  },
} as const;

export const BROADCAST_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LeadScoreResult {
  score: number;
  band: LeadBand;
  factors: LeadScoreFactor[];
}

export function bandForScore(score: number): LeadBand {
  if (score >= LEAD_SCORE_WEIGHTS.bands.hotMin) return "hot";
  if (score >= LEAD_SCORE_WEIGHTS.bands.warmMin) return "warm";
  return "cold";
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Pure scoring: signals → explainable score. No credit history is neutral
 * (none of the credit factors fire either way).
 */
export function computeLeadScore(signals: LeadScoreSignals): LeadScoreResult {
  const w = LEAD_SCORE_WEIGHTS;
  const factors: LeadScoreFactor[] = [];
  const add = (factor: string, delta: number) => {
    if (delta !== 0) factors.push({ factor, delta });
  };

  // ── RFM ──────────────────────────────────────────────────────────────────
  const d = signals.daysSinceLastOrder;
  if (d != null && d <= 7) add("recency:ordered_within_7d", w.recency.within7d);
  else if (d != null && d <= 30) add("recency:ordered_within_30d", w.recency.within30d);
  else if (d != null && d <= 90) add("recency:ordered_within_90d", w.recency.within90d);

  const freq = clamp(signals.ordersLast90d * w.frequency.perOrderLast90d, 0, w.frequency.cap);
  add("frequency:orders_last_90d", freq);

  let monetary = 0;
  for (const band of w.monetary.bands) {
    if (signals.totalSpent >= band.minSpent) {
      monetary = band.points;
      break;
    }
  }
  add("monetary:lifetime_value", clamp(monetary, 0, w.monetary.cap));

  // ── Credit behavior (no history → all neutral) ───────────────────────────
  if (signals.hasOnTimeRepayment) add("credit:on_time_repayment_history", w.credit.onTimeRepayment);
  if (signals.hasLateRepayment) add("credit:late_repayment", w.credit.lateRepayment);
  if (signals.hasActiveDefault) add("credit:active_default", w.credit.activeDefault);
  const limit = signals.creditLimitCents ?? 0;
  const outstanding = signals.creditOutstandingCents ?? 0;
  if (limit > 0 && outstanding / limit <= w.credit.healthyUtilizationMaxRatio && !signals.hasActiveDefault) {
    add("credit:healthy_utilization", w.credit.healthyUtilization);
  }

  // ── Engagement ───────────────────────────────────────────────────────────
  if (signals.repliedToLastBroadcastWithin24h) {
    add("engagement:replied_to_broadcast_within_24h", w.engagement.repliedWithin24hToLastBroadcast);
  }
  const wa = signals.daysSinceLastWhatsAppActivity;
  if (wa != null && wa <= 7) add("engagement:whatsapp_active_within_7d", w.engagement.whatsAppActiveWithin7d);

  const raw = factors.reduce((sum, f) => sum + f.delta, 0);
  const score = clamp(raw, 0, 100);
  return { score, band: bandForScore(score), factors };
}

/**
 * Derived pipeline stage from score + order history + recency. At-risk wins
 * over vip/repeat so win-back candidates always surface.
 */
export function deriveLeadStage(input: {
  score: number;
  totalOrders: number;
  daysSinceLastOrder: number | null;
  band: LeadBand;
}): LeadStage {
  const { score, totalOrders, daysSinceLastOrder, band } = input;
  if (totalOrders > 0 && band !== "hot" && (daysSinceLastOrder == null || daysSinceLastOrder > 30)) {
    return "at_risk";
  }
  if (totalOrders >= 10 && score >= LEAD_SCORE_WEIGHTS.bands.hotMin) return "vip";
  if (totalOrders >= 2) return "repeat";
  if (totalOrders === 1) return "first_order";
  // No orders yet: engaged if they have any positive signal, else new lead.
  return score > 0 ? "engaged" : "new_lead";
}

// ─── Signal collection + batch refresh ───────────────────────────────────────

type Db = any;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/** Collect scoring signals for one customer from our commerce tables. */
export async function collectLeadSignals(
  db: Db,
  tenantId: string,
  customer: { id: string; whatsappPhone: string | null; totalOrders: number; totalSpent: string | number; lastOrderAt: Date | null },
  now: Date = new Date(),
): Promise<LeadScoreSignals> {
  const since90 = new Date(now.getTime() - 90 * DAY_MS);

  const [freqRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, customer.id), gte(orders.createdAt, since90)));

  // ── Credit behavior: trade-credit ledger via POs placed by this phone ──
  let hasOnTimeRepayment = false;
  let hasLateRepayment = false;
  let hasActiveDefault = false;
  let creditLimitCents: number | null = null;
  let creditOutstandingCents: number | null = null;
  if (customer.whatsappPhone) {
    const pos = await db
      .select({ creditAccountId: purchaseOrders.creditAccountId })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.supplierTenantId, tenantId), eq(purchaseOrders.buyerPhone, customer.whatsappPhone)));
    const accountIds = Array.from(new Set(pos.map((p: any) => p.creditAccountId).filter(Boolean))) as string[];
    if (accountIds.length > 0) {
      const ledgerRows = await db
        .select({
          kind: creditLedger.kind,
          status: creditLedger.status,
          dueDate: creditLedger.dueDate,
          createdAt: creditLedger.createdAt,
        })
        .from(creditLedger)
        .where(inArray(creditLedger.creditAccountId, accountIds));
      for (const r of ledgerRows as any[]) {
        if (r.kind === "repayment") {
          if (r.dueDate && new Date(r.createdAt) > new Date(r.dueDate)) hasLateRepayment = true;
          else hasOnTimeRepayment = true;
        }
        if (r.kind === "invoice_draw" && r.status !== "settled" && r.dueDate && new Date(r.dueDate) < now) {
          hasActiveDefault = true;
        }
      }
      const accts = await db
        .select({ limit: creditAccounts.limitCents, outstanding: creditAccounts.outstandingCents })
        .from(creditAccounts)
        .where(inArray(creditAccounts.id, accountIds));
      creditLimitCents = (accts as any[]).reduce((s, a) => s + Number(a.limit ?? 0), 0);
      creditOutstandingCents = (accts as any[]).reduce((s, a) => s + Number(a.outstanding ?? 0), 0);
    }
  }

  // ── Engagement: last broadcast to this phone + reply within 24h ────────
  let repliedToLastBroadcastWithin24h = false;
  let daysSinceLastWhatsAppActivity: number | null = null;
  if (customer.whatsappPhone) {
    const [lastRecipient] = await db
      .select({ sentAt: broadcastRecipients.sentAt })
      .from(broadcastRecipients)
      .innerJoin(broadcastCampaigns, eq(broadcastRecipients.campaignId, broadcastCampaigns.id))
      .where(and(eq(broadcastCampaigns.tenantId, tenantId), eq(broadcastRecipients.phone, customer.whatsappPhone)))
      .orderBy(desc(broadcastRecipients.sentAt))
      .limit(1);

    // Inbound WhatsApp replies (whatsapp_customer_replies is written by the
    // webhook for every buyer text/media reply).
    const inbound = await db
      .select({ createdAt: whatsappCustomerReplies.createdAt })
      .from(whatsappCustomerReplies)
      .where(and(eq(whatsappCustomerReplies.tenantId, tenantId), eq(whatsappCustomerReplies.fromPhone, customer.whatsappPhone)))
      .orderBy(desc(whatsappCustomerReplies.createdAt))
      .limit(20);
    const lastInbound = (inbound as any[])[0]?.createdAt ? new Date((inbound as any[])[0].createdAt) : null;
    if (lastInbound) daysSinceLastWhatsAppActivity = daysBetween(lastInbound, now);
    if (lastRecipient?.sentAt) {
      const sentAt = new Date(lastRecipient.sentAt);
      repliedToLastBroadcastWithin24h = (inbound as any[]).some((m) => {
        const t = new Date(m.createdAt);
        return t >= sentAt && t.getTime() - sentAt.getTime() <= BROADCAST_REPLY_WINDOW_MS;
      });
    }
  }

  return {
    daysSinceLastOrder: customer.lastOrderAt ? daysBetween(new Date(customer.lastOrderAt), now) : null,
    ordersLast90d: Number((freqRow as any)?.n ?? 0),
    totalOrders: customer.totalOrders ?? 0,
    totalSpent: Number(customer.totalSpent ?? 0),
    hasOnTimeRepayment,
    hasLateRepayment,
    hasActiveDefault,
    creditLimitCents,
    creditOutstandingCents,
    repliedToLastBroadcastWithin24h,
    daysSinceLastWhatsAppActivity,
  };
}

/**
 * Batch recompute every customer score for a tenant and upsert into
 * customer_lead_scores (unique tenantId+customerId — reruns are idempotent).
 */
export async function refreshLeadScores(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ refreshed: number }> {
  const custs = await db
    .select({
      id: customers.id,
      whatsappPhone: customers.whatsappPhone,
      totalOrders: customers.totalOrders,
      totalSpent: customers.totalSpent,
      lastOrderAt: customers.lastOrderAt,
    })
    .from(customers)
    .where(eq(customers.tenantId, tenantId));

  for (const c of custs as any[]) {
    const signals = await collectLeadSignals(db, tenantId, c, now);
    const { score, band, factors } = computeLeadScore(signals);
    const stage = deriveLeadStage({
      score,
      totalOrders: signals.totalOrders,
      daysSinceLastOrder: signals.daysSinceLastOrder,
      band,
    });
    await db
      .insert(customerLeadScores)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        customerId: c.id,
        score,
        band,
        stage,
        factors,
        computedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [customerLeadScores.tenantId, customerLeadScores.customerId],
        set: { score, band, stage, factors, computedAt: now, updatedAt: now },
      });

    // Fire-and-forget Twenty push (env-gated, never blocks the refresh).
    void syncScoreToTwenty({ tenantId, customerId: c.id, score, band }).catch(() => {});
  }
  return { refreshed: (custs as any[]).length };
}

// ─── Twenty sync seam (fire-and-forget, CRM_SYNC_ENABLED-gated) ─────────────

export type TwentyScorePush = {
  tenantId: string;
  customerId: string;
  score: number;
  band: LeadBand;
};

/** Injectable fetch seam so tests can observe pushes without network. */
export let twentyScoreFetch: typeof fetch = (...args) => fetch(...args);
export function setTwentyScoreFetch(fn: typeof fetch) {
  twentyScoreFetch = fn;
}

export function isCrmSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRM_SYNC_ENABLED === "true" || env.CRM_SYNC_ENABLED === "1";
}

/**
 * Best-effort score push into Twenty (as a person custom-field update via the
 * GraphQL seam used by erpProvision/connectors). Disabled unless
 * CRM_SYNC_ENABLED=true; missing Twenty config or any failure is swallowed —
 * our customer_lead_scores table remains the source of truth for scoring.
 */
export async function syncScoreToTwenty(push: TwentyScorePush): Promise<{ pushed: boolean; reason?: string }> {
  if (!isCrmSyncEnabled()) return { pushed: false, reason: "disabled" };
  try {
    const { getTwentyIntegrationConfig } = await import("./integrationSync");
    const cfg = await getTwentyIntegrationConfig(push.tenantId);
    if (!cfg) return { pushed: false, reason: "twenty-not-configured" };
    const res = await twentyScoreFetch(`${cfg.baseUrl}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        query: `mutation UpdateLeadScore($customerId: String!, $score: Int!, $band: String!) {
          updatePerson(filter: { id: { eq: $customerId } }, data: { leadScore: $score, leadBand: $band }) { id }
        }`,
        variables: { customerId: push.customerId, score: push.score, band: push.band },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return { pushed: res.ok, reason: res.ok ? undefined : `http-${res.status}` };
  } catch (err: any) {
    return { pushed: false, reason: err?.message ?? "error" };
  }
}
