/**
 * kycGate.ts — hard KYB precondition for every money/trust surface.
 *
 * An approved KYB application (kyc_applications row with type='kyb',
 * status='approved') is a HARD precondition for:
 *   - tenant go-live (onboarding.activate)
 *   - supplier profile activation / directory trust flag (procurement)
 *   - trade-credit facility approval (tradeCredit.approveAccount)
 *
 * FAIL CLOSED: any doubt (db unavailable, query error, missing row) means
 * NOT approved. The only escape hatch is KYC_GATE_DISABLED=true, honored
 * ONLY outside production (NODE_ENV=development|test) — in production-like
 * environments the flag is ignored and the gate stays closed.
 *
 * Structure: a pure, injectable core (makeKycGate / evaluateKybRows) so
 * unit tests run without a database, plus thin db wrappers that query
 * kycApplications (same core+wrapper pattern as services/tradeCredit).
 */
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { kycApplications } from "../../drizzle/schema";
import { isProd } from "../_core/env";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Minimal row shape the core needs. */
export interface KybApplicationRow {
  tenantId: string;
  type: string;
  status: string;
}

/** Reads whether a tenant has an approved KYB application. */
export type KybApprovedReader = (tenantId: string) => Promise<boolean>;

// ─── Pure core (no db) ──────────────────────────────────────────────────────

/**
 * Pure escape-hatch evaluation. The disable flag is honored ONLY when
 * NODE_ENV is explicitly "development" or "test" — anything else (including
 * an unset NODE_ENV, which is treated as production) ignores the flag.
 */
export function kycGateDisabledFor(
  nodeEnv: string | undefined,
  disableFlag: string | undefined,
): boolean {
  if (disableFlag !== "true") return false;
  return nodeEnv === "development" || nodeEnv === "test";
}

/** True when the KYB gate is disabled for THIS process (fail closed in prod). */
export function isKycGateDisabled(): boolean {
  // isProd already fails closed on unset/unexpected NODE_ENV; require BOTH
  // the non-prod environment and the explicit flag.
  if (isProd) return false;
  return kycGateDisabledFor(process.env.NODE_ENV, process.env.KYC_GATE_DISABLED);
}

/** Pure row evaluation: does `rows` contain an approved KYB for tenantId? */
export function evaluateKybRows(rows: KybApplicationRow[], tenantId: string): boolean {
  return rows.some(
    (r) => r.tenantId === tenantId && r.type === "kyb" && r.status === "approved",
  );
}

/**
 * Injectable gate for tests: build isKybApproved / requireApprovedKyb over
 * any reader (fake db, in-memory store, …).
 */
export function makeKycGate(reader: KybApprovedReader, opts: { disabled?: boolean } = {}) {
  return {
    async isKybApproved(tenantId: string): Promise<boolean> {
      if (opts.disabled) return true;
      return reader(tenantId);
    },
    async requireApprovedKyb(tenantId: string): Promise<void> {
      if (opts.disabled) return;
      if (await reader(tenantId)) return;
      throw forbidden(tenantId);
    },
  };
}

function forbidden(tenantId: string): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message:
      `KYB verification required: tenant "${tenantId}" has no approved KYB application. ` +
      "Complete and pass KYB review before accessing this surface.",
  });
}

// ─── Thin db wrappers ───────────────────────────────────────────────────────

/**
 * Query kycApplications for an approved KYB. Any error fails closed (false).
 */
export async function hasApprovedKyb(db: DbHandle, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({
      tenantId: kycApplications.tenantId,
      type: kycApplications.type,
      status: kycApplications.status,
    })
    .from(kycApplications)
    .where(
      and(
        eq(kycApplications.tenantId, tenantId),
        eq(kycApplications.type, "kyb"),
        eq(kycApplications.status, "approved"),
      ),
    )
    .limit(1)
    .catch(() => [] as KybApplicationRow[]);
  return evaluateKybRows(rows as KybApplicationRow[], tenantId);
}

/**
 * Batch variant for directory listings: returns the set of KYB-verified tenant
 * ids. W12.1: ONE query (`inArray`) over kycApplications instead of N
 * sequential per-tenant lookups — a 100-supplier directory page went from
 * 100 round-trips to 1. Behavior identical: any error fails closed (empty set).
 */
export async function approvedKybTenantIds(db: DbHandle, tenantIds: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(tenantIds));
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({
      tenantId: kycApplications.tenantId,
      type: kycApplications.type,
      status: kycApplications.status,
    })
    .from(kycApplications)
    .where(
      and(
        inArray(kycApplications.tenantId, unique),
        eq(kycApplications.type, "kyb"),
        eq(kycApplications.status, "approved"),
      ),
    )
    .catch(() => [] as KybApplicationRow[]);
  return new Set(
    (rows as KybApplicationRow[])
      .filter((r) => evaluateKybRows([r], r.tenantId))
      .map((r) => r.tenantId),
  );
}

/**
 * Boolean check for one tenant. Honors the non-prod escape hatch; fails
 * closed when the db is unavailable.
 */
export async function isKybApproved(tenantId: string, db?: DbHandle): Promise<boolean> {
  if (isKycGateDisabled()) return true;
  const handle = db ?? (await getDb());
  if (!handle) return false; // fail closed
  return hasApprovedKyb(handle, tenantId);
}

/**
 * Hard gate: throws FORBIDDEN unless the tenant has an approved KYB
 * application (or the non-prod escape hatch is active).
 */
export async function requireApprovedKyb(tenantId: string, db?: DbHandle): Promise<void> {
  if (await isKybApproved(tenantId, db)) return;
  throw forbidden(tenantId);
}
