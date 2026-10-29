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

/** Only live/active shops are reachable by name on the shared number. */
function isReachableStatus(status: unknown): boolean {
  return status === "active";
}

export interface ResolvedShop {
  tenantId: string;
  slug: string;
  name: string;
}

/**
 * Resolve a typed shop reference (its slug or exact name) to a reachable tenant
 * on the platform number. Exact slug match first (slugs are globally unique),
 * then exact case-insensitive name among active shops. Returns null when
 * nothing matches — the caller then treats the text as a product/discovery
 * query instead. Never matches suspended/draft/inactive shops.
 */
export async function resolveShopRef(text: string | null | undefined): Promise<ResolvedShop | null> {
  const ref = normalizeShopRef(text);
  if (!ref) return null;
  const db = await getDb();
  if (!db) return null;

  const [bySlug] = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.slug, ref))
    .limit(1)
    .catch(() => [] as any[]);
  if (bySlug && isReachableStatus(bySlug.status)) {
    return { tenantId: bySlug.id, slug: bySlug.slug, name: bySlug.name };
  }

  const [byName] = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(sql`lower(${tenants.name}) = ${ref} and ${tenants.status} = 'active'`)
    .limit(1)
    .catch(() => [] as any[]);
  if (byName) {
    return { tenantId: byName.id, slug: byName.slug, name: byName.name };
  }
  return null;
}
