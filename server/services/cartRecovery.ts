/**
 * cartRecovery.ts — Abandoned-cart markers + the recovery sweep.
 *
 * Chat carts live in cart_sessions/cart_items (24h expiry). This module adds:
 *
 *  - touchCartMarker(tenantId, phone): refresh a lightweight Redis marker
 *    wa:cart:{tenant}:{phone} (24h TTL, in-memory fallback in dev/test) so
 *    activity is visible even if the DB row lags. Called on cart updates.
 *  - clearCartMarker: cart converted to an order / was emptied.
 *  - runCartRecovery: the cron sweep (POST /api/scheduled/cart-recovery).
 *    Finds cart sessions idle > 30 min that still have items, no newer order
 *    from the buyer, and NDPR consent — then sends ONE localized recovery
 *    message per cart per 24h (marker key wa:cart-recovery:{tenant}:{phone}).
 *
 * Counters are returned per run and accumulated in `recoveryCounters` for
 * metering/billing.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "../db";
import { cartItems, cartSessions, customers, orders } from "../../drizzle/schema";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { getStickyLocale, tr } from "./i18n";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const CART_MARKER_TTL_SECONDS = 24 * 3600;
export const RECOVERY_MARKER_TTL_SECONDS = 24 * 3600;
export const DEFAULT_IDLE_MINUTES = 30;

export function cartMarkerKey(tenantId: string, phone: string): string {
  return `wa:cart:${tenantId}:${phone}`;
}
export function recoveryMarkerKey(tenantId: string, phone: string): string {
  return `wa:cart-recovery:${tenantId}:${phone}`;
}

// ── Redis marker helpers (in-memory fallback mirrors chatSession.ts) ────────

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

function memoryGet(key: string): string | null {
  const row = memoryStore.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return row.value;
}

/** Test helper: wipe the in-memory marker fallback. */
export function __clearMemoryCartMarkers(): void {
  memoryStore.clear();
}

async function markerSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.setex(key, ttlSeconds, value);
      return;
    }
  } catch { /* fall through */ }
  if (isProd) return;
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function markerGet(key: string): Promise<string | null> {
  try {
    const redis = await getRedis();
    if (redis) return await redis.get(key);
  } catch { /* fall through */ }
  if (isProd) return null;
  return memoryGet(key);
}

async function markerDel(key: string): Promise<void> {
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.del(key);
      return;
    }
  } catch { /* fall through */ }
  if (isProd) return;
  memoryStore.delete(key);
}

/** Refresh the "active cart" marker — call on every chat cart update. */
export async function touchCartMarker(tenantId: string, phone: string): Promise<void> {
  if (!phone) return;
  await markerSet(cartMarkerKey(tenantId, phone), new Date().toISOString(), CART_MARKER_TTL_SECONDS);
}

/** Drop the marker when the cart converts or is emptied. */
export async function clearCartMarker(tenantId: string, phone: string): Promise<void> {
  if (!phone) return;
  await markerDel(cartMarkerKey(tenantId, phone));
}

// ── Recovery sweep ───────────────────────────────────────────────────────────

export interface RecoveryRunCounters {
  /** Cart sessions scanned in the idle window. */
  scanned: number;
  /** Passed every gate (idle, items, no order, consent, no recent send). */
  sent: number;
  skippedNoItems: number;
  skippedOrdered: number;
  skippedNoConsent: number;
  skippedRecentlySent: number;
  /** W45 MSG-10: recipient on the tenant's WA suppression list. */
  skippedSuppressed: number;
  /** W45 MSG-11: outside the 24h window and no usable template fallback. */
  skippedWindowClosed: number;
  errors: number;
}

/** Cumulative counters for metering (per process). */
export const recoveryCounters: RecoveryRunCounters = {
  scanned: 0,
  sent: 0,
  skippedNoItems: 0,
  skippedOrdered: 0,
  skippedNoConsent: 0,
  skippedRecentlySent: 0,
  skippedSuppressed: 0,
  skippedWindowClosed: 0,
  errors: 0,
};

function zeroCounters(): RecoveryRunCounters {
  return {
    scanned: 0,
    sent: 0,
    skippedNoItems: 0,
    skippedOrdered: 0,
    skippedNoConsent: 0,
    skippedRecentlySent: 0,
    skippedSuppressed: 0,
    skippedWindowClosed: 0,
    errors: 0,
  };
}

export interface AbandonedCart {
  cartSessionId: string;
  tenantId: string;
  phone: string;
  updatedAt: Date;
  items: Array<{ productName: string; quantity: number }>;
}

/**
 * Cart sessions idle since before `idleBefore` that have not expired and have
 * a WhatsApp phone attached. Items are loaded per session by the caller.
 */
export async function findIdleCartSessions(
  db: Db,
  opts: { idleBefore: Date; limit?: number; now?: Date },
): Promise<Array<{ id: string; tenantId: string; waPhoneNumber: string; updatedAt: Date }>> {
  const rows = await db
    .select({
      id: cartSessions.id,
      tenantId: cartSessions.tenantId,
      waPhoneNumber: cartSessions.waPhoneNumber,
      updatedAt: cartSessions.updatedAt,
      expiresAt: cartSessions.expiresAt,
    })
    .from(cartSessions)
    .where(lt(cartSessions.updatedAt, opts.idleBefore))
    .orderBy(desc(cartSessions.updatedAt))
    .limit(opts.limit ?? 200)
    .catch(() => [] as any[]);
  const now = opts.now ?? new Date();
  return (rows ?? []).filter(
    (r: any) =>
      typeof r?.waPhoneNumber === "string" && r.waPhoneNumber.length > 0 &&
      r.updatedAt instanceof Date && r.updatedAt < opts.idleBefore && r.updatedAt <= now &&
      // Expired carts (24h lifespan) are dead — never nudge for them.
      (!(r.expiresAt instanceof Date) || r.expiresAt > now),
  );
}

/** True when the buyer placed an order after the cart's last activity. */
async function hasNewerOrder(db: Db, tenantId: string, phone: string, since: Date): Promise<boolean> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1)
    .catch(() => [] as any[]);
  const candidates = customer ? [customer.id, phone] : [phone];
  const recent = await db
    .select({ id: orders.id, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), inArray(orders.customerId, candidates)))
    .orderBy(desc(orders.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  const latest = recent?.[0];
  return !!latest && latest.createdAt instanceof Date && latest.createdAt > since;
}

export interface CartRecoveryDeps {
  db?: Db;
  now?: Date;
  idleMinutes?: number;
  limit?: number;
  /** Injectable for tests; defaults to waSender.sendWhatsAppText. */
  sendImpl?: (tenantId: string, phone: string, body: string) => Promise<unknown>;
  /** Injectable for tests; defaults to consent.hasConsent. */
  consentImpl?: (tenantId: string, phone: string) => Promise<boolean>;
  /** === W45 messaging-services === injectable for tests/journeys. */
  /** Defaults to waSuppressionList.isSuppressed. */
  suppressionImpl?: (tenantId: string, phone: string) => Promise<boolean>;
  /** Defaults to sessionWindow.getWindow (WhatsApp carts only). */
  windowImpl?: (tenantId: string, phone: string) => Promise<{ open: boolean }>;
  /** Defaults to the W45 template fallback (sendWhatsAppTemplate). */
  templateSendImpl?: (tenantId: string, phone: string, body: string) => Promise<unknown>;
}

/**
 * One recovery sweep. For every idle cart with items and no newer order:
 * consent-gate → 24h once-per-cart marker → send the localized recovery line.
 */
export async function runCartRecovery(deps: CartRecoveryDeps = {}): Promise<RecoveryRunCounters> {
  const counters = zeroCounters();
  const db = deps.db ?? (await getDb());
  if (!db) {
    counters.errors++;
    return counters;
  }
  const now = deps.now ?? new Date();
  const idleMinutes = deps.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const idleBefore = new Date(now.getTime() - idleMinutes * 60 * 1000);

  const send: NonNullable<CartRecoveryDeps["sendImpl"]> =
    deps.sendImpl ??
    (async (tenantId, phone, body) => {
      // === W37 telegram ===
      // Telegram carts (session key `telegram:<chat_id>`) route via
      // channelSender. Telegram has NO 24h session window
      // (requiresSessionWindow('telegram') === false), so these nudges are
      // never window-suppressed; the per-cart 24h marker above still applies
      // as a once-per-cart dedupe on every channel.
      const { notifyCustomer } = await import("./channelParity");
      const routed = await notifyCustomer(tenantId, phone, "cart_abandonment", {
        text: body,
        notifType: "cart_recovery",
      });
      if (routed.handled) return routed;
      // === W37 telegram END ===
      const { sendWhatsAppText } = await import("./waSender");
      return sendWhatsAppText(tenantId, phone, body, { notifType: "cart_recovery" });
    });
  const consent: NonNullable<CartRecoveryDeps["consentImpl"]> =
    deps.consentImpl ??
    (async (tenantId, phone) => {
      const { hasConsent } = await import("./consent");
      return hasConsent(tenantId, phone);
    });
  // === W45 messaging-services ===
  const suppressed: NonNullable<CartRecoveryDeps["suppressionImpl"]> =
    deps.suppressionImpl ??
    (async (tenantId, phone) => {
      const { isSuppressed } = await import("./waSuppressionList");
      return isSuppressed(deps.db ?? db, tenantId, phone);
    });
  const windowOf: NonNullable<CartRecoveryDeps["windowImpl"]> =
    deps.windowImpl ??
    (async (tenantId, phone) => {
      const { getWindow } = await import("./sessionWindow");
      return getWindow(deps.db ?? db, tenantId, phone, now);
    });
  const sendTemplate: NonNullable<CartRecoveryDeps["templateSendImpl"]> =
    deps.templateSendImpl ??
    (async (tenantId, phone, body) => {
      // MSG-11 template fallback: outside the 24h window the recovery nudge
      // must go out as an APPROVED TEMPLATE, never free-form text.
      const { sendWhatsAppTemplate } = await import("./waSender");
      const { tenants } = await import("../../drizzle/schema");
      const [t] = await (deps.db ?? db)
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .catch(() => [] as any[]);
      const wa = (((t?.settings as any)?.whatsapp ?? {}) as Record<string, unknown>);
      const templateName =
        typeof wa.cartRecoveryTemplate === "string" && wa.cartRecoveryTemplate
          ? wa.cartRecoveryTemplate
          : "wac_cart_recovery";
      const languageCode = typeof wa.cartRecoveryLanguage === "string" && wa.cartRecoveryLanguage
        ? wa.cartRecoveryLanguage
        : "en_US";
      return sendWhatsAppTemplate(
        tenantId,
        phone,
        templateName,
        languageCode,
        [{ type: "body", parameters: [{ type: "text", text: body.slice(0, 1000) }] }],
        { notifType: "cart_recovery" },
      );
    });
  // === END W45 messaging-services ===

  const idleSessions = await findIdleCartSessions(db, { idleBefore, limit: deps.limit, now });
  counters.scanned = idleSessions.length;

  for (const cart of idleSessions) {
    try {
      const items = await db
        .select({ productName: cartItems.productName, quantity: cartItems.quantity })
        .from(cartItems)
        .where(eq(cartItems.cartSessionId, cart.id))
        .limit(10)
        .catch(() => [] as any[]);
      if (!items || items.length === 0) {
        counters.skippedNoItems++;
        await clearCartMarker(cart.tenantId, cart.waPhoneNumber);
        continue;
      }

      if (await hasNewerOrder(db, cart.tenantId, cart.waPhoneNumber, cart.updatedAt)) {
        counters.skippedOrdered++;
        await clearCartMarker(cart.tenantId, cart.waPhoneNumber);
        continue;
      }

      if (!(await consent(cart.tenantId, cart.waPhoneNumber))) {
        counters.skippedNoConsent++;
        continue;
      }

      // === W45 messaging-services (MSG-10): suppressed numbers never get nudged ===
      if (await suppressed(cart.tenantId, cart.waPhoneNumber)) {
        counters.skippedSuppressed++;
        continue;
      }

      // Once per cart per 24h — the marker survives across cron runs.
      const marker = await markerGet(recoveryMarkerKey(cart.tenantId, cart.waPhoneNumber));
      if (marker) {
        counters.skippedRecentlySent++;
        continue;
      }

      const locale = await getStickyLocale(cart.tenantId, cart.waPhoneNumber);
      const message = tr(locale, "cartRecovery");

      // === W45 messaging-services (MSG-11): 24h-window gate. Telegram has no
      // session window; WhatsApp carts outside the window fall back to the
      // approved template (a template failure lands in the outer catch as an
      // error — free-form text is NEVER sent outside the window).
      const isTelegram = cart.waPhoneNumber.startsWith("telegram:");
      let windowOpen = true;
      if (!isTelegram) {
        try {
          windowOpen = (await windowOf(cart.tenantId, cart.waPhoneNumber)).open;
        } catch {
          windowOpen = false; // fail-closed: unknown window → template path
        }
      }
      if (windowOpen) {
        await send(cart.tenantId, cart.waPhoneNumber, message);
      } else {
        await sendTemplate(cart.tenantId, cart.waPhoneNumber, message);
      }
      // === END W45 messaging-services ===
      await markerSet(
        recoveryMarkerKey(cart.tenantId, cart.waPhoneNumber),
        new Date().toISOString(),
        RECOVERY_MARKER_TTL_SECONDS,
      );
      counters.sent++;
    } catch (e: any) {
      counters.errors++;
      console.warn("[cartRecovery] cart", cart.id, "failed:", e?.message);
    }
  }

  for (const k of Object.keys(counters) as Array<keyof RecoveryRunCounters>) {
    recoveryCounters[k] += counters[k];
  }
  return counters;
}
