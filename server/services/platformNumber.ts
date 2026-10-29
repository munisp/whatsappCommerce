/**
 * server/services/platformNumber.ts — W50 shared platform WhatsApp number.
 *
 * The platform can operate ONE shared WhatsApp number that many shops use. A
 * customer messaging it either (a) names a shop (its slug or name) to enter
 * that shop, or (b) searches for a product and gets the nearest shops that
 * stock it (reusing the W25 geo discovery). Shops that bring their OWN number
 * (BYO) are reached directly on that number and are unaffected by this module.
 *
 * Config (read at call time, same convention as waOnboarding's env creds so
 * tests can stub it):
 *   WHATSAPP_PLATFORM_NUMBER_ID — the shared number's phone_number_id.
 *   WHATSAPP_PLATFORM_TOKEN     — its send credentials.
 * Either unset → no platform number exists → every predicate here is false and
 * resolvePlatformWaCredentials() is null → the webhook branch stays fully inert.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { tenants } from "../../drizzle/schema";

export interface PlatformWaCredentials {
  phoneNumberId: string;
  accessToken: string;
}

/** Platform number send creds from env; null when unconfigured (→ inert). */
export function resolvePlatformWaCredentials(): PlatformWaCredentials | null {
  const phoneNumberId = (process.env.WHATSAPP_PLATFORM_NUMBER_ID ?? "").trim();
  const accessToken = (process.env.WHATSAPP_PLATFORM_TOKEN ?? "").trim();
  if (!phoneNumberId || !accessToken) return null;
  return { phoneNumberId, accessToken };
}

/**
 * Webhook routing predicate: true only when WHATSAPP_PLATFORM_NUMBER_ID is set
 * AND the inbound payload's metadata.phone_number_id matches it. Unset env →
 * always false → the normal per-tenant dispatch path is untouched.
 */
export function isPlatformNumber(phoneNumberId: string | null | undefined): boolean {
  const configured = (process.env.WHATSAPP_PLATFORM_NUMBER_ID ?? "").trim();
  return configured.length > 0 && !!phoneNumberId && phoneNumberId.trim() === configured;
}

/**
 * Words that return a customer to the platform directory from inside a shop.
 * (The customer asked for the shared number to stay simple — no forced menu —
 * so this is the ONE escape hatch, not a navigation tree.)
 */
const HOME_WORDS = new Set(["home", "shops", "back", "exit", "main", "menu", "start"]);
export function isHomeCommand(text: string | null | undefined): boolean {
  return HOME_WORDS.has((text ?? "").trim().toLowerCase());
}

/** Normalize a shop reference (slug or name) for matching. */
export function normalizeShopRef(text: string | null | undefined): string {
  return (text ?? "").trim().toLowerCase();
}

export interface ResolvedShop {
  tenantId: string;
  slug: string;
  name: string;
}

/**
 * Resolve a typed shop reference (its slug or exact name) to a reachable shop
 * ON the platform number. Matches only SHARED shops — active AND with no own
 * WhatsApp number (whatsappPhoneNumberId IS NULL) — because a shop with its own
 * number (BYO) is reached on that number, not here, and its replies must not go
 * out from the platform number. Exact slug first (slugs are globally unique),
 * then exact case-insensitive name. Returns null when nothing matches — the
 * caller then treats the text as a product/discovery query.
 */
export async function resolveShopRef(text: string | null | undefined): Promise<ResolvedShop | null> {
  const ref = normalizeShopRef(text);
  if (!ref) return null;
  const db = await getDb();
  if (!db) return null;

  const [bySlug] = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(sql`${tenants.slug} = ${ref} and ${tenants.status} = 'active' and ${tenants.whatsappPhoneNumberId} is null`)
    .limit(1)
    .catch(() => [] as any[]);
  if (bySlug) return { tenantId: bySlug.id, slug: bySlug.slug, name: bySlug.name };

  const [byName] = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(sql`lower(${tenants.name}) = ${ref} and ${tenants.status} = 'active' and ${tenants.whatsappPhoneNumberId} is null`)
    .limit(1)
    .catch(() => [] as any[]);
  if (byName) return { tenantId: byName.id, slug: byName.slug, name: byName.name };

  return null;
}

// ── Active-shop pointer (which shop a customer is currently inside) ───────────
// Directory-level state keyed by the customer's phone (the shop-scoped chat
// session is separate, keyed {tenantId}:{phone}). Redis with the same
// dev/test in-memory fallback as chatSession; stateless in prod without Redis.

const ACTIVE_TTL_SECONDS = 1800;
const activeMemory = new Map<string, { tenantId: string; exp: number }>();
function activeKey(phone: string): string {
  return `plat:active:${(phone ?? "").replace(/\D/g, "")}`;
}

export async function getActiveShop(phone: string): Promise<string | null> {
  const key = activeKey(phone);
  try {
    const redis = await getRedis();
    if (redis) return (await redis.get(key)) || null;
  } catch (e: any) {
    console.warn("[platformNumber] active-shop get failed:", e?.message);
  }
  if (isProd) return null;
  const m = activeMemory.get(key);
  if (m && m.exp > Date.now()) return m.tenantId;
  if (m) activeMemory.delete(key);
  return null;
}

export async function setActiveShop(phone: string, tenantId: string): Promise<void> {
  const key = activeKey(phone);
  try {
    const redis = await getRedis();
    if (redis) { await redis.setex(key, ACTIVE_TTL_SECONDS, tenantId); return; }
  } catch (e: any) {
    console.warn("[platformNumber] active-shop set failed:", e?.message);
  }
  if (isProd) return;
  activeMemory.set(key, { tenantId, exp: Date.now() + ACTIVE_TTL_SECONDS * 1000 });
}

export async function clearActiveShop(phone: string): Promise<void> {
  const key = activeKey(phone);
  try {
    const redis = await getRedis();
    if (redis) { await redis.del(key); return; }
  } catch (e: any) {
    console.warn("[platformNumber] active-shop clear failed:", e?.message);
  }
  activeMemory.delete(key);
}

/** Test-only: reset the in-memory active-shop map. */
export function __clearActiveShopMemory(): void {
  activeMemory.clear();
}
