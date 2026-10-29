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
import { decryptSecret } from "./crypto/secrets";

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
 * Platform send creds, full resolution: the env token when set, otherwise the
 * designated creds tenant's OWN encrypted token (WHATSAPP_PLATFORM_CREDS_TENANT_ID
 * + WHATSAPP_PLATFORM_NUMBER_ID) — so a shop's already-stored token can back the
 * platform number without copying the plaintext anywhere. null when unconfigured.
 */
export async function resolvePlatformWaCredentialsFull(): Promise<PlatformWaCredentials | null> {
  const env = resolvePlatformWaCredentials();
  if (env) return env;
  const phoneNumberId = (process.env.WHATSAPP_PLATFORM_NUMBER_ID ?? "").trim();
  const credsTenantId = (process.env.WHATSAPP_PLATFORM_CREDS_TENANT_ID ?? "").trim();
  if (!phoneNumberId || !credsTenantId) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const [t] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, credsTenantId))
      .limit(1)
      .catch(() => [] as any[]);
    const raw = (((t?.settings as any)?.whatsapp ?? {}) as any).accessToken;
    if (typeof raw !== "string" || !raw) return null;
    const accessToken = decryptSecret(raw);
    if (!accessToken) return null;
    return { phoneNumberId, accessToken };
  } catch (e: any) {
    console.warn("[platformNumber] creds-tenant resolve failed:", e?.message);
    return null;
  }
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

/**
 * A greeting / noise message (not a shop name and not a product search) — gets
 * the directory prompt rather than being treated as a product query, so a bare
 * "hi" doesn't become "find shops with 'hi'".
 */
const GREETINGS = new Set(["hi", "hello", "hey", "yo", "hiya", "hola", "help", "ok", "okay", "thanks", "ty"]);
export function isGreeting(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/^good\s+(morning|afternoon|evening|day)\b/.test(t)) return true;
  return GREETINGS.has(t.split(/\s+/)[0]);
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

// ── Per-customer directory state ─────────────────────────────────────────────
// Keyed by the customer's phone (the shop-scoped chat session is separate,
// keyed {tenantId}:{phone}): the active shop they're inside, a pending product
// search awaiting their location, and their last shared location. Redis with
// the same dev/test in-memory fallback as chatSession; stateless in prod
// without Redis. One tiny generic KV backs all three.

const ACTIVE_TTL_SECONDS = 1800;
const PENDING_TTL_SECONDS = 600;
const LOC_TTL_SECONDS = 3600;
const kvMemory = new Map<string, { v: string; exp: number }>();
function digits(phone: string): string {
  return (phone ?? "").replace(/\D/g, "");
}

async function kvGet(key: string): Promise<string | null> {
  try {
    const redis = await getRedis();
    if (redis) return (await redis.get(key)) || null;
  } catch (e: any) {
    console.warn("[platformNumber] kv get failed:", e?.message);
  }
  if (isProd) return null;
  const m = kvMemory.get(key);
  if (m && m.exp > Date.now()) return m.v;
  if (m) kvMemory.delete(key);
  return null;
}
async function kvSet(key: string, val: string, ttl: number): Promise<void> {
  try {
    const redis = await getRedis();
    if (redis) { await redis.setex(key, ttl, val); return; }
  } catch (e: any) {
    console.warn("[platformNumber] kv set failed:", e?.message);
  }
  if (isProd) return;
  kvMemory.set(key, { v: val, exp: Date.now() + ttl * 1000 });
}
async function kvDel(key: string): Promise<void> {
  try {
    const redis = await getRedis();
    if (redis) { await redis.del(key); return; }
  } catch (e: any) {
    console.warn("[platformNumber] kv del failed:", e?.message);
  }
  kvMemory.delete(key);
}

/** Which shop the customer is currently inside (tenantId), or null. */
export const getActiveShop = (phone: string): Promise<string | null> => kvGet(`plat:active:${digits(phone)}`);
export const setActiveShop = (phone: string, tenantId: string): Promise<void> => kvSet(`plat:active:${digits(phone)}`, tenantId, ACTIVE_TTL_SECONDS);
export const clearActiveShop = (phone: string): Promise<void> => kvDel(`plat:active:${digits(phone)}`);

/** A product search awaiting the customer's location (run once they share it). */
export const getPendingQuery = (phone: string): Promise<string | null> => kvGet(`plat:pendq:${digits(phone)}`);
export const setPendingQuery = (phone: string, q: string): Promise<void> => kvSet(`plat:pendq:${digits(phone)}`, q, PENDING_TTL_SECONDS);
export const clearPendingQuery = (phone: string): Promise<void> => kvDel(`plat:pendq:${digits(phone)}`);

export interface LatLng { lat: number; lng: number; }
/** The customer's last shared location (for repeat searches without re-asking). */
export async function getCustomerLocation(phone: string): Promise<LatLng | null> {
  const raw = await kvGet(`plat:loc:${digits(phone)}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p?.lat === "number" && typeof p?.lng === "number") return { lat: p.lat, lng: p.lng };
  } catch { /* corrupt → treat as absent */ }
  return null;
}
export const setCustomerLocation = (phone: string, loc: LatLng): Promise<void> => kvSet(`plat:loc:${digits(phone)}`, JSON.stringify(loc), LOC_TTL_SECONDS);

/** Test-only: reset all in-memory directory state. */
export function __clearActiveShopMemory(): void {
  kvMemory.clear();
}
