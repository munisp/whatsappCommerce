// === W64 intelligence (R9) ===
/**
 * Proactive push ops — scheduled sweep driven by
 * POST /api/scheduled/proactive-nudges (scheduler.mjs allowlist, J178 parity).
 *
 * Nudge types (all WA+TG parity via channelParity.notifyCustomer with the
 * sendWhatsAppText fallback; all i18n via MESSAGE_CATALOG ×8):
 *   1. low_stock        — merchant admin: product at/below threshold, with a
 *                         one-tap restock draft link (inventory portal).
 *   2. order_aging      — merchant admin: 'pending' order aging > 24h.
 *   3. payment_due      — buyer: open buyer_installment_plans schedule entry
 *                         due within 48h (W56 credit installments).
 *   4. credit_offer     — buyer: personalized credit offer at purchase-time
 *                         eligibility (W57 grade A/B in credit_scores).
 *
 * Discipline:
 *   - Idempotent per (tenant, type, subject, UTC day): claim-first INSERT
 *     INTO proactive_nudges ON CONFLICT DO NOTHING — a sweep re-run or a
 *     double-fire never double-nudges.
 *   - Quiet hours honoured via the existing marketing-frequency pattern
 *     (frequencyCap.parseMarketingFrequencyPolicy + isQuietHours). Inside
 *     quiet hours the subject is SKIPPED WITHOUT claiming, so the next
 *     post-quiet sweep can still send the day's nudge.
 *   - Fail-open everywhere: a send failure is logged, never thrown.
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  buyerInstallmentPlans,
  creditScores,
  orders,
  proactiveNudges,
  products,
  tenants,
} from "../../drizzle/schema";
import { interpolate, getStickyLocale, t27 } from "./i18n";
import { isQuietHours, parseMarketingFrequencyPolicy } from "./frequencyCap";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const AGING_ORDER_HOURS = 24;
export const PAYMENT_DUE_LOOKAHEAD_HOURS = 48;
/** Grade bands eligible for a proactive purchase-time credit offer. */
export const CREDIT_OFFER_GRADES = new Set(["A", "B"]);

function appBase(): string {
  return (process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Claim-first idempotency: true when this (day,type,subject) is fresh. */
async function claimNudge(db: Db, tenantId: string, nudgeType: string, subjectId: string, day: string): Promise<boolean> {
  // RETURNING id: PGlite execute does not expose rowCount for a plain
  // INSERT ... ON CONFLICT DO NOTHING — count returned rows instead.
  const res = await db.execute(sql`
    INSERT INTO proactive_nudges (tenant_id, nudge_type, subject_id, day, status)
    VALUES (${tenantId}, ${nudgeType}, ${subjectId}, ${day}, 'claimed')
    ON CONFLICT (tenant_id, nudge_type, subject_id, day) DO NOTHING
    RETURNING id
  `).catch((e: any) => {
    console.warn("[proactive] claim failed (fail-open, skip send):", e?.message);
    return null;
  });
  const rows = (res as any)?.rows ?? res ?? [];
  return Array.isArray(rows) ? rows.length === 1 : Number((res as any)?.rowCount ?? 0) === 1;
}

/** Tenant settings + quiet-hours gate. */
async function tenantContext(db: Db, tenantId: string) {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const settings = ((tenant as any)?.settings ?? {}) as Record<string, unknown>;
  const policy = parseMarketingFrequencyPolicy(settings);
  const quiet = isQuietHours(new Date(), policy);
  const adminPhone = typeof settings.adminPhone === "string" ? settings.adminPhone : "";
  return { settings, quiet, adminPhone };
}

/** WA+TG parity send (telegram-linked recipients route via channelParity). */
async function sendParity(tenantId: string, to: string, notifType: string, text: string): Promise<void> {
  const { notifyCustomer } = await import("./channelParity");
  const tg = await notifyCustomer(tenantId, to, "ops_alert", { text, notifType }).catch(() => ({ handled: false }) as any);
  if ((tg as any)?.handled) return;
  const { sendWhatsAppText } = await import("./waSender");
  await sendWhatsAppText(tenantId, to, text, { notifType }).catch((e: any) =>
    console.warn("[proactive] WA send failed (fail-open):", e?.message));
}

async function buyerText(tenantId: string, phone: string, key: Parameters<typeof t27>[1], vars: Record<string, string | number>): Promise<string> {
  const locale = (await getStickyLocale(tenantId, phone).catch(() => null)) ?? "en";
  return interpolate(t27(locale, key), vars);
}

async function adminText(tenantId: string, adminPhone: string, key: Parameters<typeof t27>[1], vars: Record<string, string | number>): Promise<string> {
  const locale = (await getStickyLocale(tenantId, adminPhone).catch(() => null)) ?? "en";
  return interpolate(t27(locale, key), vars);
}

export interface ProactiveRun {
  lowStock: number;
  orderAging: number;
  paymentDue: number;
  creditOffer: number;
  skippedQuiet: number;
}

/** Main sweep. Returns per-type counts (sent). Never throws. */
export async function runProactiveNudges(opts: { now?: Date } = {}): Promise<ProactiveRun> {
  const out: ProactiveRun = { lowStock: 0, orderAging: 0, paymentDue: 0, creditOffer: 0, skippedQuiet: 0 };
  try {
    const db = await getDb();
    if (!db) return out;
    const day = utcDay(opts.now ?? new Date());

    // ── 1. Low-stock merchant nudges (with one-tap restock draft link) ────
    const lowRows = await db.execute(sql`
      SELECT p."tenantId" AS "tenantId", p.id, p.name, p."stockQuantity",
             COALESCE(p."lowStockThreshold", 10) AS threshold
      FROM products p
      WHERE p.status = 'active' AND p."stockQuantity" <= COALESCE(p."lowStockThreshold", 10)
      ORDER BY p."updatedAt" DESC LIMIT 200
    `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
    for (const p of lowRows as any[]) {
      try {
        const ctx = await tenantContext(db, p.tenantId);
        if (!ctx.adminPhone) continue;
        if (ctx.quiet) { out.skippedQuiet += 1; continue; }
        if (!(await claimNudge(db, p.tenantId, "low_stock", p.id, day))) continue;
        const url = `${appBase()}/inventory?restock=${p.id}`;
        const body = await adminText(p.tenantId, ctx.adminPhone, "nudgeLowStock", {
          product: p.name, stock: p.stockQuantity, url,
        });
        await sendParity(p.tenantId, ctx.adminPhone, "proactive_low_stock", body);
        out.lowStock += 1;
      } catch (e: any) {
        console.warn("[proactive] low-stock nudge failed (fail-open):", e?.message);
      }
    }

    // ── 2. Aging pending-order reminders (merchant admin) ────────────────
    const aging = await db.execute(sql`
      SELECT o."tenantId" AS "tenantId", o.id, o."orderNumber",
             EXTRACT(EPOCH FROM (now() - o."createdAt")) / 3600.0 AS hours
      FROM orders o
      WHERE o.status = 'pending' AND o."createdAt" < now() - (${AGING_ORDER_HOURS} * interval '1 hour')
      ORDER BY o."createdAt" ASC LIMIT 100
    `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
    for (const o of aging as any[]) {
      try {
        const ctx = await tenantContext(db, o.tenantId);
        if (!ctx.adminPhone) continue;
        if (ctx.quiet) { out.skippedQuiet += 1; continue; }
        if (!(await claimNudge(db, o.tenantId, "order_aging", o.id, day))) continue;
        const body = await adminText(o.tenantId, ctx.adminPhone, "nudgeOrderAging", {
          orderNumber: o.orderNumber, hours: Math.max(1, Math.floor(Number(o.hours))),
        });
        await sendParity(o.tenantId, ctx.adminPhone, "proactive_order_aging", body);
        out.orderAging += 1;
      } catch (e: any) {
        console.warn("[proactive] order-aging nudge failed (fail-open):", e?.message);
      }
    }

    // ── 3. Payment-due reminders (buyer installments schedule entries) ────
    const plans = await db
      .select()
      .from(buyerInstallmentPlans)
      .where(eq(buyerInstallmentPlans.status, "active"))
      .limit(200)
      .catch(() => [] as any[]);
    const nowMs = (opts.now ?? new Date()).getTime();
    for (const plan of plans as any[]) {
      try {
        const schedule = (plan.schedule ?? []) as Array<{ seq: number; dueAt: string; amountCents: number; status: string }>;
        const due = schedule.find((s) => {
          if (s.status !== "pending") return false;
          const t = new Date(s.dueAt).getTime();
          return t >= nowMs - 3600_000 && t <= nowMs + PAYMENT_DUE_LOOKAHEAD_HOURS * 3600_000;
        });
        if (!due) continue;
        const ctx = await tenantContext(db, plan.tenantId);
        if (ctx.quiet) { out.skippedQuiet += 1; continue; }
        if (!(await claimNudge(db, plan.tenantId, "payment_due", `${plan.id}:${due.seq}`, day))) continue;
        const [ord] = await db.select({ orderNumber: orders.orderNumber }).from(orders)
          .where(eq(orders.id, plan.orderId)).limit(1).catch(() => [] as any[]);
        const body = await buyerText(plan.tenantId, plan.buyerPhone, "nudgePaymentDue", {
          amount: (due.amountCents / 100).toFixed(2),
          currency: plan.currency,
          orderNumber: (ord as any)?.orderNumber ?? plan.orderId,
          date: due.dueAt.slice(0, 10),
        });
        await sendParity(plan.tenantId, plan.buyerPhone, "proactive_payment_due", body);
        out.paymentDue += 1;
      } catch (e: any) {
        console.warn("[proactive] payment-due nudge failed (fail-open):", e?.message);
      }
    }

    // ── 4. Personalized purchase-time credit offers (W57 grades A/B) ──────
    const eligible = await db
      .select()
      .from(creditScores)
      .where(and(eq(creditScores.subjectType, "buyer")))
      .orderBy(desc(creditScores.updatedAt))
      .limit(200)
      .catch(() => [] as any[]);
    for (const s of eligible as any[]) {
      try {
        if (!CREDIT_OFFER_GRADES.has(String(s.grade))) continue;
        const ctx = await tenantContext(db, s.tenantId);
        if (ctx.quiet) { out.skippedQuiet += 1; continue; }
        if (!(await claimNudge(db, s.tenantId, "credit_offer", s.subjectId, day))) continue;
        // Offer sized from the score bands (integer cents; display only).
        const amountCents = s.grade === "A" ? 5_000_000 : 2_000_000;
        const body = await buyerText(s.tenantId, s.subjectId, "nudgeCreditOffer", {
          amount: (amountCents / 100).toFixed(2), currency: "NGN",
        });
        await sendParity(s.tenantId, s.subjectId, "proactive_credit_offer", body);
        out.creditOffer += 1;
      } catch (e: any) {
        console.warn("[proactive] credit-offer nudge failed (fail-open):", e?.message);
      }
    }
  } catch (e: any) {
    console.error("[proactive] sweep failed (fail-open):", e?.message);
  }
  return out;
}
// === END W64 intelligence (R9) ===
