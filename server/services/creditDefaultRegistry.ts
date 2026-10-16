// === W57 risk-shield ===
/**
 * creditDefaultRegistry.ts — Feature 2: cross-tenant default registry.
 *
 * One row per (origin tenantId, accountId) keyed by identityHash — the
 * HMAC-SHA256 of the subject's primary identity link (identityGraph). Raw
 * BVN/NIN/phone are NEVER stored.
 *
 * Write path: the dunning +7d freeze milestone (the platform's "default"
 * enforcement moment — account frozen, order access suspended) calls
 * recordDefault() (idempotent: unique (tenantId, accountId),
 * onConflictDoNothing). Cure path: full repayment (outstanding → 0 in
 * tradeCredit/repayment.ts) flips active→cured claim-first.
 *
 * CROSS-TENANT PRIVACY: shared reads expose ONLY the aggregate
 * { hasActiveDefault, count } via crossTenantDefaultStatus() — origin
 * tenantId, amounts and account refs are NEVER returned to other tenants.
 * The tenant-scoped listDefaults() is the only detail read and requires the
 * origin tenant's own authz (router enforces assertTenantAccess).
 *
 * Bureau report-back: bureauRef stays NULL unless the subject has a live
 * bureau consent artefact (existing bureau.ts rules) — stampBureauRef() is
 * only called from consent-gated paths.
 */
import { and, eq, sql } from "drizzle-orm";
import { creditDefaultRegistry, identityLinks } from "../../drizzle/schema";
import { hashIdentityLink } from "./identityGraph";
import type { DbHandle } from "./tradeCredit/accounts";

export type RegistryStatus = "active" | "disputed" | "cured" | "cleared";

function logLine(level: "info" | "warn", metric: string, extra: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ level, metric, ...extra }) + "\n");
  } catch { /* telemetry must never break the credit path */ }
}

/**
 * Resolve the registry identityHash for a subject: prefer an existing
 * bvn/nin link hash (strongest identity), then phone, then email; fall back
 * to hashing the subjectId itself as a 'phone'-scoped synthetic identity so
 * every default is still registry-visible. Never throws on missing links.
 */
export async function resolveIdentityHash(
  db: DbHandle,
  subjectType: "buyer" | "merchant",
  subjectId: string,
): Promise<string> {
  const links = (await db
    .select({ linkType: identityLinks.linkType, linkHash: identityLinks.linkHash })
    .from(identityLinks)
    .where(and(eq(identityLinks.subjectType, subjectType), eq(identityLinks.subjectId, subjectId)))
    .catch(() => [] as any[])) as unknown as { linkType: string; linkHash: string }[];
  for (const preferred of ["bvn", "nin", "phone", "email"]) {
    const hit = links.find((l) => l.linkType === preferred);
    if (hit) return hit.linkHash;
  }
  // Synthetic fallback — still HMAC'd, still no raw PII at rest.
  return hashIdentityLink("phone", `subject:${subjectType}:${subjectId}`);
}

/**
 * Record a default. Idempotent via the unique (tenantId, accountId) index.
 * Returns { created, id }.
 */
export async function recordDefault(
  db: DbHandle,
  opts: {
    tenantId: string; // ORIGIN tenant
    accountId: string;
    amountCents: number;
    subjectType?: "buyer" | "merchant";
    subjectId?: string;
    identityHash?: string; // caller may pre-resolve
    defaultedAt?: Date;
  },
): Promise<{ created: boolean; id: string | null }> {
  if (!Number.isSafeInteger(opts.amountCents) || opts.amountCents < 0) {
    throw new Error("amountCents must be a non-negative integer (cents)");
  }
  const identityHash = opts.identityHash
    ?? await resolveIdentityHash(db, opts.subjectType ?? "merchant", opts.subjectId ?? opts.accountId);
  const rows = (await db
    .insert(creditDefaultRegistry)
    .values({
      identityHash,
      tenantId: opts.tenantId,
      accountId: opts.accountId,
      amountCents: opts.amountCents,
      defaultedAt: opts.defaultedAt ?? new Date(),
      status: "active",
    })
    .onConflictDoNothing()
    .returning({ id: creditDefaultRegistry.id })) as unknown as { id: string }[];
  const created = rows.length > 0;
  if (created) {
    logLine("warn", "credit_default_recorded", { tenantId: opts.tenantId, accountId: opts.accountId, amountCents: opts.amountCents });
  }
  return { created, id: rows[0]?.id ?? null };
}

/**
 * Cure a default on full repayment. Claim-first active→cured (disputed rows
 * stay disputed until admin review). tenantId is optional — account ids are
 * globally unique uuids, so the accountId match is sufficient; when tenantId
 * is provided it narrows the update. Returns true when THIS call cured.
 */
export async function cureDefault(
  db: DbHandle,
  opts: { tenantId?: string; accountId: string; now?: Date },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const where = opts.tenantId
    ? and(eq(creditDefaultRegistry.accountId, opts.accountId), eq(creditDefaultRegistry.tenantId, opts.tenantId), eq(creditDefaultRegistry.status, "active"))
    : and(eq(creditDefaultRegistry.accountId, opts.accountId), eq(creditDefaultRegistry.status, "active"));
  const rows = (await db
    .update(creditDefaultRegistry)
    .set({ status: "cured", curedAt: now, updatedAt: now })
    .where(where)
    .returning({ id: creditDefaultRegistry.id })) as unknown as { id: string }[];
  if (rows.length > 0) {
    logLine("info", "credit_default_cured", { accountId: opts.accountId });
  }
  return rows.length > 0;
}

/**
 * Cross-tenant AGGREGATE read — the ONLY cross-tenant query. Returns
 * { hasActiveDefault, count } for an identity hash; origin tenant, amounts
 * and account refs are intentionally NOT exposed (privacy).
 */
export async function crossTenantDefaultStatus(
  db: DbHandle,
  identityHash: string,
): Promise<{ hasActiveDefault: boolean; activeDefaults: number }> {
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(creditDefaultRegistry)
    .where(and(eq(creditDefaultRegistry.identityHash, identityHash), eq(creditDefaultRegistry.status, "active")))) as unknown as { n: number }[];
  const n = Number(rows[0]?.n ?? 0);
  return { hasActiveDefault: n > 0, activeDefaults: n };
}

/** Tenant-scoped detail list (origin tenant only — router enforces authz). */
export async function listDefaults(db: DbHandle, tenantId: string, limit = 50) {
  return (await db
    .select()
    .from(creditDefaultRegistry)
    .where(eq(creditDefaultRegistry.tenantId, tenantId))
    .orderBy(creditDefaultRegistry.defaultedAt)
    .limit(Math.max(1, Math.min(limit, 200)))) as unknown as (typeof creditDefaultRegistry.$inferSelect)[];
}

/**
 * Stamp the bureau reference — ONLY from consent-gated report-back paths
 * (bureau.ts reportRepayment with a live consent artefact). Claim-first on
 * null bureauRef.
 */
export async function stampBureauRef(db: DbHandle, id: string, bureauRef: string): Promise<boolean> {
  const rows = (await db
    .update(creditDefaultRegistry)
    .set({ bureauRef: bureauRef.slice(0, 128), updatedAt: new Date() })
    .where(and(eq(creditDefaultRegistry.id, id), sql`${creditDefaultRegistry.bureauRef} IS NULL`))
    .returning({ id: creditDefaultRegistry.id })) as unknown as { id: string }[];
  return rows.length > 0;
}
// === END W57 risk-shield ===
