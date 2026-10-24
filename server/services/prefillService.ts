// === W64 intelligence (R4) ===
/**
 * KYC OCR prefill — reuses the LATEST APPROVED kyc_applications row's
 * extracted identity/business data (kyc_documents.extractedData from the
 * OCR/VLM pipeline, routers/kyc.ts:308) to prefill identity/business/bank
 * forms elsewhere (payout account setup W59, POS terminal registration,
 * credit applications).
 *
 * Privacy: kyc_applications carries NO raw BVN/NIN columns by design — only
 * the hashes/extracted JSON on documents. We surface ONLY non-secret fields
 * (names, business registration, address). `bvn`/`nin` keys present in
 * extractedData are NEVER returned (they exist only as hashes downstream in
 * the W57 identity graph).
 *
 * Confirm-edit contract: this service only READS. Callers render the
 * suggested values into an editable form; NOTHING is auto-submitted — the
 * user confirms the existing mutation paths unchanged.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import { kycApplications, kycDocuments } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface KycPrefill {
  /** null when the tenant has no approved KYC application. */
  available: boolean;
  applicationId?: string;
  approvedAt?: string;
  /** Individual identity fields (from applicant + extractedData). */
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  /** Business fields (KYB). */
  businessName?: string | null;
  businessRegistrationNumber?: string | null;
  businessCountry?: string | null;
  businessType?: string | null;
  /** Bank details when the OCR captured them (e.g. bank statement doc). */
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountName?: string | null;
}

const SECRET_KEYS = new Set(["bvn", "nin", "bvnHash", "ninHash"]);

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    if (SECRET_KEYS.has(k)) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Latest approved-KYC prefill bundle for a tenant. Fail-open: any error
 * returns { available: false } so form pages render their manual path.
 */
export async function getKycPrefill(db: Db, tenantId: string): Promise<KycPrefill> {
  try {
    const [app] = await db
      .select()
      .from(kycApplications)
      .where(and(eq(kycApplications.tenantId, tenantId), eq(kycApplications.status, "approved")))
      .orderBy(desc(kycApplications.approvedAt))
      .limit(1);
    if (!app) return { available: false };

    const docs = await db
      .select({ extractedData: kycDocuments.extractedData })
      .from(kycDocuments)
      .where(and(eq(kycDocuments.applicationId, app.id), isNotNull(kycDocuments.extractedData)))
      .limit(10);

    // Merge extracted JSON across documents (first non-empty wins; secrets
    // filtered by pickStr).
    const merged: Record<string, unknown> = {};
    for (const d of docs) {
      const x = (d.extractedData ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(x)) {
        if (SECRET_KEYS.has(k)) continue;
        if (merged[k] == null && typeof v === "string" && v.trim()) merged[k] = v;
      }
    }

    return {
      available: true,
      applicationId: app.id,
      approvedAt: app.approvedAt?.toISOString(),
      fullName: app.applicantName ?? pickStr(merged, ["fullName", "full_name", "name", "surname"]),
      phone: app.applicantPhone ?? pickStr(merged, ["phone", "phoneNumber", "phone_number"]),
      email: app.applicantEmail ?? pickStr(merged, ["email"]),
      dateOfBirth: pickStr(merged, ["dateOfBirth", "date_of_birth", "dob"]),
      address: pickStr(merged, ["address", "residential_address", "business_address"]),
      businessName: app.businessName ?? pickStr(merged, ["businessName", "business_name", "company_name", "rc_name"]),
      businessRegistrationNumber:
        app.businessRegistrationNumber ?? pickStr(merged, ["businessRegistrationNumber", "rc_number", "registrationNumber", "cac_number"]),
      businessCountry: app.businessCountry ?? pickStr(merged, ["businessCountry", "country"]),
      businessType: app.businessType ?? pickStr(merged, ["businessType", "business_type"]),
      bankName: pickStr(merged, ["bankName", "bank_name", "bank"]),
      bankAccountNumber: pickStr(merged, ["bankAccountNumber", "account_number", "accountNumber"]),
      bankAccountName: pickStr(merged, ["bankAccountName", "account_name", "accountName"]),
    };
  } catch (e: any) {
    console.warn("[prefill] kyc prefill failed (fail-open):", e?.message);
    return { available: false };
  }
}
// === END W64 intelligence (R4) ===
