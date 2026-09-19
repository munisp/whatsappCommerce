// === W47 stakeholders ===
/**
 * vendors.ts — ONB-S-8 vendor payee vetting (mig 0168).
 *
 * Vendor bills used to pay real wallet money to unvetted free-form payees
 * (vendorContact jsonb). This service adds a first-class vendor registry:
 *
 *  - Dedup: vendors are keyed by (tenantId, nameKey) where nameKey is the
 *    lowercased name with all non-alphanumerics stripped — "ABC Supplies",
 *    "abc supplies ltd"-style drift still dedups on the stripped core.
 *  - Structured payout account: bank code + account number are validated
 *    at write (NGN NUBAN = exactly 10 digits; bank code 3-6 alnum); an
 *    account name is mandatory whenever an account number is present.
 *  - Payee lock: routers/vendorBills.update refuses to change payee
 *    details once a bill is approved/paid (editable window = pre-approval).
 *  - KYB tier before first wallet payout: recordVendorBillPayment refuses
 *    the FIRST payout to a registered vendor until the TENANT holds an
 *    approved KYB (fail-closed via kycGate), then stamps firstPaidAt.
 */
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { vendors, type Vendor } from "../../drizzle/schema";

type Db = any;

export class VendorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VendorError";
    this.code = code;
  }
}

/** Normalised dedup key for a vendor name. */
export function vendorNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 160);
}

export interface PayeeInput {
  phone?: string;
  email?: string;
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
}

/** Validate structured payee fields; throws VendorError on bad formats. */
export function validatePayee(p: PayeeInput): PayeeInput {
  const out: PayeeInput = {};
  if (p.phone != null && p.phone !== "") {
    const digits = p.phone.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      throw new VendorError("invalid-payee", "payee phone must be 7-15 digits");
    }
    out.phone = p.phone.trim();
  }
  if (p.email != null && p.email !== "") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
      throw new VendorError("invalid-payee", "payee email is malformed");
    }
    out.email = p.email.trim();
  }
  if (p.bankCode != null && p.bankCode !== "") {
    if (!/^[A-Za-z0-9]{3,6}$/.test(p.bankCode.trim())) {
      throw new VendorError("invalid-payee", "bank code must be 3-6 alphanumeric characters");
    }
    out.bankCode = p.bankCode.trim();
  }
  if (p.accountNumber != null && p.accountNumber !== "") {
    if (!/^\d{10}$/.test(p.accountNumber.trim())) {
      throw new VendorError("invalid-payee", "account number must be exactly 10 digits (NUBAN)");
    }
    out.accountNumber = p.accountNumber.trim();
  }
  if (out.accountNumber || out.bankCode) {
    if (!p.accountName?.trim()) {
      throw new VendorError("invalid-payee", "account name is required when a payout account is captured");
    }
    if (!out.accountNumber || !out.bankCode) {
      throw new VendorError("invalid-payee", "bank code AND account number are required together");
    }
    out.accountName = p.accountName!.trim();
  }
  return out;
}

/**
 * Upsert the vendor registry row for (tenantId, name). Dedup: an existing
 * row with the same nameKey is REUSED (canonical vendor) — the payee
 * fields are refreshed only when supplied. Returns { vendor, deduped }.
 */
export async function upsertVendor(
  db: Db,
  input: {
    tenantId: string;
    name: string;
    payee?: PayeeInput;
    actor?: string;
  },
): Promise<{ vendor: Vendor; deduped: boolean }> {
  const name = input.name?.trim();
  if (!name) throw new VendorError("invalid-vendor", "vendor name required");
  const nameKey = vendorNameKey(name);
  if (!nameKey) throw new VendorError("invalid-vendor", "vendor name has no alphanumeric content");
  const payee = input.payee ? validatePayee(input.payee) : {};
  const now = new Date();
  const [existing] = await db.select().from(vendors)
    .where(and(eq(vendors.tenantId, input.tenantId), eq(vendors.nameKey, nameKey)))
    .limit(1);
  if (existing) {
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const k of ["phone", "email", "bankCode", "accountNumber", "accountName"] as const) {
      if ((payee as any)[k] !== undefined) patch[k] = (payee as any)[k];
    }
    await db.update(vendors).set(patch).where(eq(vendors.id, existing.id));
    const [row] = await db.select().from(vendors).where(eq(vendors.id, existing.id));
    return { vendor: row, deduped: true };
  }
  const id = crypto.randomUUID();
  await db.insert(vendors).values({
    id,
    tenantId: input.tenantId,
    name,
    nameKey,
    phone: payee.phone ?? null,
    email: payee.email ?? null,
    bankCode: payee.bankCode ?? null,
    accountNumber: payee.accountNumber ?? null,
    accountName: payee.accountName ?? null,
    createdBy: input.actor ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id));
  return { vendor: row, deduped: false };
}

/**
 * KYB-tier gate before the FIRST wallet payout to a registered vendor.
 * Fail-closed: any doubt (no vendor row, db error inside kycGate) refuses.
 */
export async function requireVendorFirstPayoutGate(db: Db, tenantId: string, vendorId: string): Promise<Vendor> {
  const [vendor] = await db.select().from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.tenantId, tenantId)))
    .limit(1);
  if (!vendor) throw new VendorError("not-found", "vendor not found");
  if (vendor.firstPaidAt) return vendor; // already vetted by first payout
  if (vendor.status !== "active") {
    throw new VendorError("inactive", `vendor ${vendor.name} is ${vendor.status}`);
  }
  const { requireApprovedKyb } = await import("./kycGate");
  await requireApprovedKyb(tenantId, db);
  return vendor;
}

/** Stamp the vendor's first successful payout (KYB-tier vetting complete). */
export async function markVendorFirstPaid(db: Db, vendorId: string): Promise<void> {
  await db.update(vendors)
    .set({ firstPaidAt: new Date(), kybTier: "basic", updatedAt: new Date() })
    .where(and(eq(vendors.id, vendorId), isNull(vendors.firstPaidAt)))
    .catch(() => undefined);
}
// === END W47 stakeholders ===
