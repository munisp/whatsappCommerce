/**
 * procurement/directory.ts — Supplier directory for B2B procurement.
 *
 * Lists ACTIVE supplier_profiles (optionally filtered by category) with the
 * terms a buyer cares about: MOQ, lead time, offered credit terms — plus the
 * calling buyer's existing trade-credit account summary with that supplier
 * (via S1's tradeCredit engine), so the buyer can see "you already have
 * ₦X credit here" before starting a PO.
 */
import { eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { supplierProfiles, tenants, type SupplierProfile } from "../../../drizzle/schema";
import { getCreditAccount } from "../tradeCredit";
import { approvedKybTenantIds } from "../kycGate";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Credit-account summary attached to directory entries (null = no account). */
export interface DirectoryCreditSummary {
  accountId: string;
  status: string;
  limitCents: number;
  outstandingCents: number;
  termsDays: number;
  /** Trade-credit enforcement (credit_accounts.suspended) — drives UX badges. */
  suspended: boolean;
  suspensionReason: string | null;
}

export interface SupplierDirectoryEntry {
  tenantId: string;
  name: string | null;
  moqCents: number;
  leadTimeDays: number;
  termsOffered: number[];
  defaultTermsDays: number;
  categories: string[];
  /** True when the supplier tenant has an approved KYB application. */
  kybVerified: boolean;
  credit: DirectoryCreditSummary | null;
}

/** Fetch one supplier profile row (any status) by supplier tenant id. */
export async function getSupplierProfile(
  db: DbHandle,
  supplierTenantId: string,
): Promise<SupplierProfile | null> {
  const [row] = await db
    .select()
    .from(supplierProfiles)
    .where(eq(supplierProfiles.tenantId, supplierTenantId))
    .limit(1)
    .catch(() => [] as SupplierProfile[]);
  return row ?? null;
}

/** Only ACTIVE profiles may receive new POs / appear in the directory. */
export async function getActiveSupplierProfile(
  db: DbHandle,
  supplierTenantId: string,
): Promise<SupplierProfile | null> {
  const profile = await getSupplierProfile(db, supplierTenantId);
  return profile && profile.status === "active" ? profile : null;
}

function creditSummaryOf(account: any): DirectoryCreditSummary | null {
  if (!account) return null;
  return {
    accountId: String(account.id ?? ""),
    status: String(account.status ?? "active"),
    limitCents: Number(account.limitCents ?? 0),
    outstandingCents: Number(account.outstandingCents ?? 0),
    termsDays: Number(account.termsDays ?? 0),
    suspended: account.suspended === true,
    suspensionReason:
      typeof account.suspensionReason === "string" && account.suspensionReason.trim()
        ? account.suspensionReason.trim()
        : typeof account.suspension_reason === "string" && account.suspension_reason.trim()
          ? account.suspension_reason.trim()
          : null,
  };
}

/**
 * List active suppliers. `category` matches against the profile's categories
 * jsonb (string array); buyers see their credit summary per supplier.
 * The caller's own tenant is excluded — a tenant cannot buy from itself.
 */
export async function listSuppliers(
  db: DbHandle,
  opts: { buyerTenantId?: string; category?: string; limit?: number } = {},
): Promise<SupplierDirectoryEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = await db
    .select({
      profile: supplierProfiles,
      tenantName: tenants.name,
    })
    .from(supplierProfiles)
    .leftJoin(tenants, eq(tenants.id, supplierProfiles.tenantId))
    .where(eq(supplierProfiles.status, "active"))
    .limit(200)
    .catch(() => [] as Array<{ profile: SupplierProfile; tenantName: string | null }>);

  const category = opts.category?.trim().toLowerCase();
  const filtered = (rows ?? []).filter(({ profile }) => {
    if (opts.buyerTenantId && profile.tenantId === opts.buyerTenantId) return false;
    if (!category) return true;
    const cats = Array.isArray(profile.categories) ? (profile.categories as string[]) : [];
    return cats.some((c) => String(c).toLowerCase() === category);
  });

  // W12.1: KYB trust flags resolved in ONE batched query (inArray over
  // kycApplications) instead of a per-supplier round-trip — O(1) queries, not
  // O(n). Fails closed (empty set → all flags false) on any lookup error.
  const page = filtered.slice(0, limit);
  const kybVerifiedIds = await approvedKybTenantIds(db, page.map(({ profile }) => profile.tenantId));

  const out: SupplierDirectoryEntry[] = [];
  for (const { profile, tenantName } of page) {
    let credit: DirectoryCreditSummary | null = null;
    if (opts.buyerTenantId) {
      const account = await getCreditAccount(profile.tenantId, opts.buyerTenantId)
        .catch((e: any) => {
          console.warn("[procurement.directory] credit lookup failed:", e?.message);
          return null;
        });
      credit = creditSummaryOf(account);
    }
    // KYB trust flag — fails closed (false) on any lookup error.
    const kybVerified = kybVerifiedIds.has(profile.tenantId);
    out.push({
      tenantId: profile.tenantId,
      name: tenantName ?? null,
      moqCents: Number(profile.moqCents ?? 0),
      leadTimeDays: Number(profile.leadTimeDays ?? 3),
      termsOffered: Array.isArray(profile.termsOffered) ? (profile.termsOffered as number[]) : [],
      defaultTermsDays: Number(profile.defaultTermsDays ?? 14),
      categories: Array.isArray(profile.categories) ? (profile.categories as string[]) : [],
      kybVerified,
      credit,
    });
  }
  return out;
}

export interface UpsertSupplierProfileInput {
  tenantId: string;
  moqCents?: number;
  leadTimeDays?: number;
  termsOffered?: number[];
  defaultTermsDays?: number;
  autoApproveBelowCents?: number | null;
  categories?: string[];
  status?: "active" | "paused";
}

/** Create or update the caller's OWN supplier profile (idempotent upsert). */
export async function upsertSupplierProfile(
  db: DbHandle,
  input: UpsertSupplierProfileInput,
): Promise<SupplierProfile> {
  const now = new Date();
  const existing = await getSupplierProfile(db, input.tenantId);
  const values = {
    tenantId: input.tenantId,
    moqCents: input.moqCents ?? existing?.moqCents ?? 0,
    leadTimeDays: input.leadTimeDays ?? existing?.leadTimeDays ?? 3,
    termsOffered: input.termsOffered ?? (existing?.termsOffered as number[] | null) ?? null,
    defaultTermsDays: input.defaultTermsDays ?? existing?.defaultTermsDays ?? 14,
    autoApproveBelowCents:
      input.autoApproveBelowCents === undefined ? existing?.autoApproveBelowCents ?? null : input.autoApproveBelowCents,
    categories: input.categories ?? (existing?.categories as string[] | null) ?? null,
    status: input.status ?? existing?.status ?? "active",
    updatedAt: now,
  };
  if (existing) {
    await db.update(supplierProfiles).set(values).where(eq(supplierProfiles.tenantId, input.tenantId));
  } else {
    await db.insert(supplierProfiles).values({ ...values, createdAt: now });
  }
  return (await getSupplierProfile(db, input.tenantId))!;
}
