/**
 * 24h WhatsApp session-window manager.
 *
 * Meta's customer-service window: a tenant may send free-form messages for
 * 24h after the buyer's last inbound message; afterwards only approved
 * templates are allowed.
 *
 * Inbound timestamps are tracked in Redis (key `wa:sw:{tenant}:{phone}`,
 * TTL 30h, in-memory fallback in dev/test) — `recordInbound` is called at
 * webhook entry for EVERY message type. `getWindow` falls back to the
 * whatsapp_customer_replies table (where the webhook records text/media
 * replies) so windows survive a Redis flush.
 *
 * Also owns the pending-payment window-expiry nudge used by the
 * /api/scheduled/window-expiry-check cron: orders unpaid for >20h whose
 * window closes in <4h (or is already closed) get a buyer nudge (free-form
 * text while the window is open, the tenant's broadcast template when
 * closed) and the tenant adminPhone is flagged once per order.
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { customers, orders, tenants } from "../../drizzle/schema";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { normalizeWaPhone, sendWhatsAppTemplate, sendWhatsAppText } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Meta customer-service window length. */
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Redis TTL for the last-inbound marker (slightly longer than the window). */
const WINDOW_KEY_TTL_S = 30 * 60 * 60;

// ── Inbound marker store ─────────────────────────────────────────────────────

const memoryStore = new Map<string, number>();

function windowKey(tenantId: string, phone: string): string {
  return `wa:sw:${tenantId}:${normalizeWaPhone(phone)}`;
}

/**
 * Record an inbound buyer message. Called at webhook entry for every message
 * type — Redis-primary so it never collides with the richer
 * whatsapp_customer_replies inserts (which carry body/media and run later in
 * the text/media branches). Never throws.
 */
export async function recordInbound(tenantId: string, phone: string, ts: Date = new Date()): Promise<void> {
  const key = windowKey(tenantId, phone);
  const at = ts.getTime();
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.set(key, String(at), "EX", WINDOW_KEY_TTL_S);
      return;
    }
    if (isProd) {
      console.error("[sessionWindow] Redis unavailable in production — falling back to DB-only window state");
      return;
    }
  } catch (err: any) {
    if (isProd) {
      console.error("[sessionWindow] recordInbound failed:", err?.message);
      return;
    }
  }
  memoryStore.set(key, at);
}

export interface SessionWindow {
  open: boolean;
  closesAt: Date | null;
  lastInboundAt: Date | null;
  source: "redis" | "memory" | "replies" | "none";
}

/**
 * Resolve the current window state for a (tenant, phone): open when the last
 * inbound is <24h old. Redis/in-memory marker first, then the
 * whatsapp_customer_replies table as the durable fallback.
 */
export async function getWindow(db: Db, tenantId: string, phone: string, now: Date = new Date()): Promise<SessionWindow> {
  const key = windowKey(tenantId, phone);
  let at: number | null = null;
  let source: SessionWindow["source"] = "none";
  try {
    const redis = await getRedis();
    if (redis) {
      const raw = await redis.get(key);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed)) {
        at = parsed;
        source = "redis";
      }
    }
  } catch (err: any) {
    console.warn("[sessionWindow] redis read failed:", err?.message);
  }
  if (at == null && memoryStore.has(key)) {
    at = memoryStore.get(key)!;
    source = "memory";
  }
  if (at == null) {
    try {
      const res: any = await db.execute(
        sql`SELECT MAX(created_at) AS last_at FROM whatsapp_customer_replies WHERE tenant_id = ${tenantId} AND from_phone = ${phone}`,
      );
      const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
      const last = rows[0]?.last_at ? new Date(rows[0].last_at) : null;
      if (last && !Number.isNaN(last.getTime())) {
        at = last.getTime();
        source = "replies";
      }
    } catch (err: any) {
      console.warn("[sessionWindow] replies fallback lookup failed:", err?.message);
    }
  }
  if (at == null) return { open: false, closesAt: null, lastInboundAt: null, source: "none" };
  const closesAt = new Date(at + WA_WINDOW_MS);
  return { open: now.getTime() - at < WA_WINDOW_MS, closesAt, lastInboundAt: new Date(at), source };
}

/**
 * Latest inbound per phone for a whole tenant — the durable map used by the
 * broadcast audience builder (same source as before: whatsapp_customer_replies).
 */
export async function getLastInboundMap(db: Db, tenantId: string): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  try {
    const res: any = await db.execute(
      sql`SELECT from_phone AS phone, MAX(created_at) AS last_at FROM whatsapp_customer_replies WHERE tenant_id = ${tenantId} GROUP BY from_phone`,
    );
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    for (const r of rows) {
      const phone = normalizeWaPhone(String(r?.phone ?? ""));
      const at = r?.last_at ? new Date(r.last_at) : null;
      if (phone && at && !Number.isNaN(at.getTime())) map.set(phone, at);
    }
  } catch (e: any) {
    console.warn("[sessionWindow] last-inbound lookup failed (defaulting to template sends):", e?.message);
  }
  return map;
}

/** Test helper: clear the in-memory fallback store. */
export function __resetSessionWindowStoreForTests(): void {
  memoryStore.clear();
}

// ── Pending-payment window-expiry nudge ──────────────────────────────────────

/** Orders unpaid for longer than this are candidates for the nudge. */
export const WINDOW_NUDGE_MIN_AGE_MS = 20 * 60 * 60 * 1000;
/** Nudge when the window closes within this horizon. */
export const WINDOW_NUDGE_CLOSING_MS = 4 * 60 * 60 * 1000;

const memoryFlagLedger = new Set<string>();

/**
 * Once-per-key claim (Redis SET NX, in-memory fallback in dev/test). Used to
 * fire the admin flag and the buyer nudge at most once per order.
 */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (redis) {
      const res = await redis.set(key, "1", "EX", ttlSeconds, "NX");
      return res === "OK";
    }
    if (isProd) {
      console.error("[sessionWindow] Redis unavailable in production — dedupe degraded (may re-fire)");
      return true;
    }
  } catch (err: any) {
    if (isProd) {
      console.error("[sessionWindow] dedupe claim failed:", err?.message);
      return true;
    }
  }
  if (memoryFlagLedger.has(key)) return false;
  memoryFlagLedger.add(key);
  return true;
}

/** Test helper: clear the in-memory dedupe ledger. */
export function __resetWindowFlagLedgerForTests(): void {
  memoryFlagLedger.clear();
}

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

export interface WindowExpiryResult {
  scanned: number;
  nudged: number;
  flagged: number;
}

/**
 * Scan orders pending payment for >20h and nudge buyers whose 24h window is
 * closing (<4h) or already closed — free-form text while open, the tenant's
 * configured broadcast template when closed. Flags the tenant adminPhone
 * once per order. Never throws into the cron caller.
 */
export async function runWindowExpiryCheck(db: Db, now: Date = new Date()): Promise<WindowExpiryResult> {
  const cutoff = new Date(now.getTime() - WINDOW_NUDGE_MIN_AGE_MS);
  let dueOrders: Array<typeof orders.$inferSelect> = [];
  try {
    dueOrders = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.paymentStatus, "unpaid"),
          sql`${orders.createdAt} <= ${cutoff.toISOString()}`,
        ),
      )
      .limit(200);
  } catch (err: any) {
    console.error("[sessionWindow] expiry scan failed:", err?.message);
    return { scanned: 0, nudged: 0, flagged: 0 };
  }

  let nudged = 0;
  let flagged = 0;
  for (const order of dueOrders) {
    try {
      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, order.tenantId), eq(customers.id, order.customerId)))
        .limit(1)
        .catch(() => []);
      // Chat orders store the raw WhatsApp phone in orders.customerId (not a
      // customers.id) — resolve it directly, mirroring reorder/logistics, or
      // the nudge would silently skip every chat-placed order.
      const rawCustomerId = (order.customerId ?? "").trim();
      const phone = customer?.whatsappPhone
        ?? (/^\+?\d{7,15}$/.test(rawCustomerId) ? rawCustomerId : null);
      if (!phone) continue;
      const win = await getWindow(db, order.tenantId, phone, now);
      const closingSoon = win.open && win.closesAt != null && win.closesAt.getTime() - now.getTime() < WINDOW_NUDGE_CLOSING_MS;
      if (!closingSoon && win.open) continue; // window comfortably open — no nudge yet

      // Buyer nudge at most once per order (36h comfortably covers the window).
      if (await claimOnce(`window-expiry:nudge:${order.id}`, 36 * 3600)) {
        const nudgeBody =
          `Hi ${customer?.name ?? "there"} — your order ${order.orderNumber} is still awaiting payment. ` +
          `Complete your payment soon so we can reserve your items. Reply here if you need help!`;
        if (win.open) {
          await sendWhatsAppText(order.tenantId, phone, nudgeBody, { notifType: "window_expiry_nudge", orderId: order.id });
        } else {
          const [tenant] = await db
            .select({ settings: tenants.settings })
            .from(tenants)
            .where(eq(tenants.id, order.tenantId))
            .limit(1)
            .catch(() => []);
          const b = (((tenant?.settings as any)?.broadcast ?? {}) as Record<string, unknown>);
          const templateName = typeof b.templateName === "string" && b.templateName ? b.templateName : "wac_broadcast";
          const languageCode = typeof b.languageCode === "string" && b.languageCode ? b.languageCode : "en_US";
          await sendWhatsAppTemplate(
            order.tenantId,
            phone,
            templateName,
            languageCode,
            [{ type: "body", parameters: [{ type: "text", text: customer?.name ?? "Customer" }] }],
            { notifType: "window_expiry_nudge", orderId: order.id },
          );
        }
        nudged++;
      }

      // Admin flag at most once per order.
      if (await claimOnce(`window-expiry:flag:${order.id}`, 7 * 24 * 3600)) {
        const [tenant] = await db
          .select({ settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, order.tenantId))
          .limit(1)
          .catch(() => []);
        const adminPhone = adminPhoneFromSettings(tenant?.settings);
        if (adminPhone) {
          const windowNote = win.open
            ? `their messaging window closes at ${win.closesAt?.toISOString()}`
            : "their messaging window has closed (template used)";
          await sendWhatsAppText(
            order.tenantId,
            adminPhone,
            `⏰ Order ${order.orderNumber} (${order.totalAmount} ${order.currency}) is unpaid >20h and ${windowNote}. A payment nudge was sent to the buyer.`,
            { notifType: "window_expiry_flag", orderId: order.id },
          );
          flagged++;
        }
      }
    } catch (err: any) {
      console.error(`[sessionWindow] expiry nudge failed for order ${order.id}:`, err?.message);
    }
  }
  return { scanned: dueOrders.length, nudged, flagged };
}
