/**
 * Multi-domain tenant resolution.
 *
 * Public storefronts and tracking pages can be served from tenant-owned
 * domains. This module resolves the incoming Host header to a tenant:
 *
 *   1. Exact match against tenants.settings.domains (string[] of hosts).
 *   2. Subdomain match: {slug}.{base domain of APP_URL} → tenant by slug.
 *   3. Otherwise the platform default tenant ("default").
 *
 * Resolution is cached in-process for 60s so hot public paths do not hit
 * the database on every request. Failures (DB down) fall back to the
 * default tenant and are NOT cached, so recovery is immediate.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { ENV } from "./env";

export const DEFAULT_TENANT_ID = "default";
export const TENANT_DOMAIN_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  tenantId: string;
  expiresAt: number;
}

const hostCache = new Map<string, CacheEntry>();

/** Test hook: clear the in-process resolution cache. */
export function clearTenantDomainCache(): void {
  hostCache.clear();
}

/** Lowercase, strip port and trailing dot. Returns "" for missing hosts. */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  // Strip port (IPv4/hostname form; bracketed IPv6 is not a tenant host).
  const colon = h.indexOf(":");
  if (colon > -1) h = h.slice(0, colon);
  return h;
}

/** Base domain of the platform app URL (e.g. "app.example.com"). */
export function appBaseHost(): string {
  try {
    return normalizeHost(new URL(ENV.appUrl).hostname);
  } catch {
    return "";
  }
}

/** Read the configured custom domains from a tenant settings blob. */
export function tenantDomains(settings: unknown): string[] {
  const d = (settings as Record<string, unknown> | null)?.domains;
  if (!Array.isArray(d)) return [];
  return d.filter((x): x is string => typeof x === "string").map(normalizeHost).filter(Boolean);
}

interface TenantRow {
  id: string;
  slug: string;
  settings: unknown;
}

async function loadTenants(): Promise<TenantRow[]> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  return db
    .select({ id: tenants.id, slug: tenants.slug, settings: tenants.settings })
    .from(tenants);
}

/**
 * Resolve a Host header value to a tenant id. Never throws — on any
 * failure returns the default tenant id.
 */
export async function resolveTenantForHost(host: string | null | undefined): Promise<string> {
  const h = normalizeHost(host);
  if (!h) return DEFAULT_TENANT_ID;

  const cached = hostCache.get(h);
  if (cached && cached.expiresAt > Date.now()) return cached.tenantId;

  const base = appBaseHost();
  // The platform's own domain (or www) always serves the default tenant —
  // no DB lookup needed.
  if (base && (h === base || h === `www.${base}`)) {
    hostCache.set(h, { tenantId: DEFAULT_TENANT_ID, expiresAt: Date.now() + TENANT_DOMAIN_CACHE_TTL_MS });
    return DEFAULT_TENANT_ID;
  }

  let rows: TenantRow[];
  try {
    rows = await loadTenants();
  } catch (e: any) {
    console.warn("[tenantDomain] tenant lookup failed, using default:", e?.message);
    return DEFAULT_TENANT_ID; // deliberately NOT cached — recover as soon as DB is back
  }

  // 1. Exact custom-domain match (tenants.settings.domains).
  let resolved: string | null = null;
  for (const t of rows) {
    if (tenantDomains(t.settings).includes(h)) {
      resolved = t.id;
      break;
    }
  }

  // 2. Subdomain match: {slug}.{base}.
  if (!resolved && base && h.endsWith(`.${base}`)) {
    const slug = h.slice(0, h.length - base.length - 1);
    if (slug && !slug.includes(".")) {
      const t = rows.find((r) => r.slug === slug);
      if (t) resolved = t.id;
    }
  }

  const tenantId = resolved ?? DEFAULT_TENANT_ID;
  hostCache.set(h, { tenantId, expiresAt: Date.now() + TENANT_DOMAIN_CACHE_TTL_MS });
  return tenantId;
}

/** Look up a tenant row by id (used by the public tenantTheme procedure). */
export async function getTenantByIdForTheme(tenantId: string) {
  const db = await getDb();
  if (!db) return null;
  if (tenantId === DEFAULT_TENANT_ID) {
    // The default tenant may not have a row — return null so callers use defaults.
    const [t] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .catch(() => []);
    return t ?? null;
  }
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t ?? null;
}
