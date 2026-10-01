// === W57 risk-shield ===
/**
 * creditInsurance.ts — Feature 3: provider-agnostic CREDIT insurance
 * adapter (distinct from W27 order add-on insurance.ts, which is untouched).
 *
 * Pattern mirrors bureau.ts (W56): provider resolved from tenant
 * settings.creditInsurance.provider with env fallback
 * (CREDIT_INSURANCE_PROVIDER; sim default 'sim', prod default 'disabled'),
 * secrets via decryptSecret envelopes (resolveInsuranceSecret), HTTP through
 * net/resilientFetch.fetchJson with a bounded timeout, and FAIL-OPEN
 * semantics — an insurance outage NEVER blocks credit flows (quote/bind/
 * claim return { ok:false, error } instead of throwing for transport
 * reasons).
 *
 * Premium table (deterministic, integer bps of principal by grade band —
 * documented contract, unit-tested):
 *   A 150bps · B 300bps · C 500bps · D 800bps · E 1200bps
 * premium = round(principalCents * bps / 10_000) — integer cents, no floats.
 *
 * Claim status machine: filed → under_review → paid | rejected
 * (claim-first guarded UPDATEs — a settled claim never re-settles). The sim
 * provider deterministically pays claims whose defaultRef hashes even and
 * rejects otherwise — same input → same outcome, no network.
 *
 * Paid payouts flow through the provision-fund seam: a PAID claim whose
 * payout is BELOW the defaulted principal leaves a shortfall eligible for a
 * provision-fund draw (Feature 4, provisionFund.ts).
 */
import { createHash } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { creditInsuranceClaims, creditInsurancePolicies } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";
import { fetchJson } from "./net/resilientFetch";
import { DEFAULT_TIMEOUT_MS, redactSecrets } from "./compliance/fakeHttp";
import type { Grade } from "./creditScoring";
import type { DbHandle } from "./tradeCredit/accounts";

export type CreditInsuranceProvider = "disabled" | "sim" | "http";
export type ClaimStatus = "filed" | "under_review" | "paid" | "rejected";

/** Deterministic premium table: bps of principal by grade band. */
export const PREMIUM_BPS_BY_GRADE: Record<Grade, number> = {
  A: 150,
  B: 300,
  C: 500,
  D: 800,
  E: 1200,
};

function logLine(level: "info" | "warn", metric: string, extra: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ level, metric, ...extra }) + "\n");
  } catch { /* telemetry must never break credit flows */ }
}

// ── Config ──────────────────────────────────────────────────────────────────

export function resolveInsuranceProvider(
  tenantSettings: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): CreditInsuranceProvider {
  const s = (tenantSettings as any)?.creditInsurance?.provider;
  const raw = String(typeof s === "string" && s.trim() ? s : env.CREDIT_INSURANCE_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "http" || raw === "sim" || raw === "disabled") return raw;
  if ((env.SIM_MODE ?? "").trim() === "true" || (env.NODE_ENV ?? "") === "test") return "sim";
  return "disabled";
}

/** Resolve a secret that may be a decryptSecret envelope (bureau.ts pattern). */
export function resolveInsuranceSecret(value: string | undefined | null): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    const dec = decryptSecret(raw);
    return dec || raw;
  } catch {
    return raw;
  }
}

export function insuranceTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CREDIT_INSURANCE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

// ── Quote (pure, deterministic) ─────────────────────────────────────────────

export interface PremiumQuoteResult {
  principalCents: number;
  grade: Grade;
  premiumBps: number;
  premiumCents: number;
}

/**
 * Deterministic premium quote: premium = principalCents × grade bps /
 * 10_000, rounded half-up, integer cents. Same inputs → same premium.
 */
export function quotePremium(principalCents: number, grade: Grade): PremiumQuoteResult {
  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw new Error("principalCents must be a positive integer (cents)");
  }
  const premiumBps = PREMIUM_BPS_BY_GRADE[grade];
  if (premiumBps == null) throw new Error(`unknown grade ${grade}`);
  const premiumCents = Math.round((principalCents * premiumBps) / 10_000);
  return { principalCents, grade, premiumBps, premiumCents };
}

// ── Bind ────────────────────────────────────────────────────────────────────

/** Deterministic idempotency key for binding a policy to a facility. */
export function bindPolicyKey(tenantId: string, facilityRef: string): string {
  return `w57:bind:${tenantId}:${facilityRef}`.slice(0, 160);
}

export interface InsuranceFetchOverrides {
  fetcher?: typeof fetchJson;
  env?: NodeJS.ProcessEnv;
}

/** Sim provider: deterministic reference derived from the facility ref. */
function simProviderRef(kind: "policy" | "claim", ref: string): string {
  const digest = createHash("sha256").update(`w57-insurance:${kind}:${ref}`).digest("hex");
  return `sim:${digest.slice(0, 24)}`;
}

/**
 * Bind a policy on a facility. Idempotent: the unique idempotencyKey +
 * (tenantId, facilityRef) make replays return the existing policy. FAIL-OPEN
 * on provider transport: returns { ok:false, error } — never throws.
 */
export async function bindPolicy(
  db: DbHandle,
  opts: {
    tenantId: string;
    facilityRef: string;
    principalCents: number;
    grade: Grade;
    tenantSettings?: Record<string, unknown> | null;
  },
  overrides: InsuranceFetchOverrides = {},
): Promise<{ ok: boolean; policy?: typeof creditInsurancePolicies.$inferSelect; duplicate?: boolean; error?: string }> {
  const provider = resolveInsuranceProvider(opts.tenantSettings ?? null, overrides.env ?? process.env);
  if (provider === "disabled") {
    return { ok: false, error: "provider_disabled" };
  }
  let quote: PremiumQuoteResult;
  try {
    quote = quotePremium(opts.principalCents, opts.grade);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  // Idempotency: existing live policy for this facility wins.
  const existing = (await db
    .select()
    .from(creditInsurancePolicies)
    .where(and(eq(creditInsurancePolicies.tenantId, opts.tenantId), eq(creditInsurancePolicies.facilityRef, opts.facilityRef)))
    .limit(1)) as unknown as (typeof creditInsurancePolicies.$inferSelect)[];
  if (existing[0]) return { ok: true, policy: existing[0], duplicate: true };

  let providerRef: string | null = null;
  if (provider === "sim") {
    providerRef = simProviderRef("policy", `${opts.tenantId}:${opts.facilityRef}`);
  } else {
    const env = overrides.env ?? process.env;
    const url = (env.CREDIT_INSURANCE_URL ?? "").trim();
    const apiKey = resolveInsuranceSecret(env.CREDIT_INSURANCE_API_KEY);
    if (!url) return { ok: false, error: "CREDIT_INSURANCE_URL is not configured" };
    try {
      const fetcher = overrides.fetcher ?? fetchJson;
      const res = await fetcher<any>(url, {
        integration: "credit-insurance-bind",
        timeoutMs: insuranceTimeoutMs(env),
        retries: 0,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            facility_ref: opts.facilityRef,
            principal_cents: quote.principalCents,
            premium_cents: quote.premiumCents,
            grade: opts.grade,
          }),
        },
      });
      if (!(res as any).ok) throw new Error(`bind responded HTTP ${(res as any).status ?? "?"}`);
      providerRef = String((res as any).data?.policy_ref ?? (res as any).body?.policy_ref ?? "").slice(0, 128) || null;
    } catch (e: any) {
      const message = redactSecrets(String(e?.message ?? e).slice(0, 300), apiKey ? [apiKey] : []);
      logLine("warn", "credit_insurance_bind_failed", { tenantId: opts.tenantId, error: message });
      return { ok: false, error: message }; // fail-open — never blocks credit
    }
  }

  const rows = (await db
    .insert(creditInsurancePolicies)
    .values({
      tenantId: opts.tenantId,
      facilityRef: opts.facilityRef,
      principalCents: quote.principalCents,
      premiumCents: quote.premiumCents,
      grade: opts.grade,
      provider,
      providerRef,
      status: "bound",
      idempotencyKey: bindPolicyKey(opts.tenantId, opts.facilityRef),
    })
    .onConflictDoNothing()
    .returning()) as unknown as (typeof creditInsurancePolicies.$inferSelect)[];
  if (rows[0]) {
    logLine("info", "credit_insurance_bound", { tenantId: opts.tenantId, facilityRef: opts.facilityRef, premiumCents: quote.premiumCents });
    return { ok: true, policy: rows[0] };
  }
  const raced = (await db
    .select()
    .from(creditInsurancePolicies)
    .where(and(eq(creditInsurancePolicies.tenantId, opts.tenantId), eq(creditInsurancePolicies.facilityRef, opts.facilityRef)))
    .limit(1)) as unknown as (typeof creditInsurancePolicies.$inferSelect)[];
  return { ok: true, policy: raced[0], duplicate: true };
}

// ── Claims ──────────────────────────────────────────────────────────────────

export function fileClaimKey(tenantId: string, policyId: string, defaultRef: string): string {
  return `w57:claim:${tenantId}:${policyId}:${defaultRef}`.slice(0, 160);
}

/** Sim claim adjudication: deterministic on the defaultRef hash. */
export function simClaimOutcome(defaultRef: string): "paid" | "rejected" {
  const digest = createHash("sha256").update(`w57-insurance:adjudicate:${defaultRef}`).digest();
  return digest[0] % 2 === 0 ? "paid" : "rejected";
}

/**
 * File a claim on a bound policy for a default. Idempotent via
 * idempotencyKey. Files as 'filed', then the provider adjudicates:
 * sim resolves synchronously (deterministic), http hands off and the claim
 * sits at 'under_review' until resolveClaim(). Fail-open on transport.
 */
export async function fileClaim(
  db: DbHandle,
  opts: {
    tenantId: string;
    policyId: string;
    defaultRef: string;
    evidence: { ledgerRefs?: string[]; dunningMarkers?: string[] };
    tenantSettings?: Record<string, unknown> | null;
    now?: Date;
  },
  overrides: InsuranceFetchOverrides = {},
): Promise<{ ok: boolean; claim?: typeof creditInsuranceClaims.$inferSelect; duplicate?: boolean; error?: string }> {
  const now = opts.now ?? new Date();
  const policies = (await db
    .select()
    .from(creditInsurancePolicies)
    .where(and(eq(creditInsurancePolicies.id, opts.policyId), eq(creditInsurancePolicies.tenantId, opts.tenantId)))
    .limit(1)) as unknown as (typeof creditInsurancePolicies.$inferSelect)[];
  const policy = policies[0];
  if (!policy) return { ok: false, error: "policy_not_found" };

  const key = fileClaimKey(opts.tenantId, opts.policyId, opts.defaultRef);
  const existing = (await db
    .select()
    .from(creditInsuranceClaims)
    .where(eq(creditInsuranceClaims.idempotencyKey, key))
    .limit(1)) as unknown as (typeof creditInsuranceClaims.$inferSelect)[];
  if (existing[0]) return { ok: true, claim: existing[0], duplicate: true };

  const provider = (policy.provider as CreditInsuranceProvider) ?? "sim";
  let status: ClaimStatus = "filed";
  let payoutCents: number | null = null;

  if (provider === "sim") {
    // Deterministic synchronous adjudication: filed → under_review → paid|rejected.
    const outcome = simClaimOutcome(opts.defaultRef);
    status = outcome;
    payoutCents = outcome === "paid" ? policy.principalCents : null;
  } else if (provider === "http") {
    const env = overrides.env ?? process.env;
    const url = (env.CREDIT_INSURANCE_URL ?? "").trim();
    const apiKey = resolveInsuranceSecret(env.CREDIT_INSURANCE_API_KEY);
    if (!url) return { ok: false, error: "CREDIT_INSURANCE_URL is not configured" };
    try {
      const fetcher = overrides.fetcher ?? fetchJson;
      const res = await fetcher<any>(url, {
        integration: "credit-insurance-claim",
        timeoutMs: insuranceTimeoutMs(env),
        retries: 0,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            policy_ref: policy.providerRef,
            default_ref: opts.defaultRef,
            evidence: opts.evidence,
          }),
        },
      });
      if (!(res as any).ok) throw new Error(`claim responded HTTP ${(res as any).status ?? "?"}`);
      status = "under_review";
    } catch (e: any) {
      const message = redactSecrets(String(e?.message ?? e).slice(0, 300), apiKey ? [apiKey] : []);
      logLine("warn", "credit_insurance_claim_failed", { tenantId: opts.tenantId, error: message });
      return { ok: false, error: message }; // fail-open
    }
  }

  const resolved = status === "paid" || status === "rejected";
  const rows = (await db
    .insert(creditInsuranceClaims)
    .values({
      tenantId: opts.tenantId,
      policyId: opts.policyId,
      defaultRef: opts.defaultRef.slice(0, 64),
      evidence: { ledgerRefs: opts.evidence.ledgerRefs ?? [], dunningMarkers: opts.evidence.dunningMarkers ?? [] },
      status,
      payoutCents,
      idempotencyKey: key,
      resolvedAt: resolved ? now : null,
    })
    .onConflictDoNothing()
    .returning()) as unknown as (typeof creditInsuranceClaims.$inferSelect)[];
  if (!rows[0]) {
    const raced = (await db.select().from(creditInsuranceClaims).where(eq(creditInsuranceClaims.idempotencyKey, key)).limit(1)) as unknown as (typeof creditInsuranceClaims.$inferSelect)[];
    return { ok: true, claim: raced[0], duplicate: true };
  }
  if (resolved) {
    // Policy consumed — claim-first flip bound→claimed.
    await db
      .update(creditInsurancePolicies)
      .set({ status: "claimed", updatedAt: now })
      .where(and(eq(creditInsurancePolicies.id, opts.policyId), eq(creditInsurancePolicies.status, "bound")));
  }
  logLine("info", "credit_insurance_claim_filed", { tenantId: opts.tenantId, policyId: opts.policyId, status });
  return { ok: true, claim: rows[0] };
}

/**
 * Resolve an under_review claim (http provider callback / admin decision).
 * Claim-first: only 'filed'|'under_review' → paid|rejected; settled claims
 * never re-settle.
 */
export async function resolveClaim(
  db: DbHandle,
  opts: { claimId: string; tenantId: string; decision: "paid" | "rejected"; payoutCents?: number; now?: Date },
): Promise<{ ok: boolean; changed: boolean; claim?: typeof creditInsuranceClaims.$inferSelect }> {
  const now = opts.now ?? new Date();
  if (opts.decision === "paid") {
    if (!Number.isSafeInteger(opts.payoutCents) || (opts.payoutCents ?? 0) <= 0) {
      throw new Error("payoutCents must be a positive integer (cents) for a paid claim");
    }
  }
  const flipped = (await db
    .update(creditInsuranceClaims)
    .set({
      status: opts.decision,
      payoutCents: opts.decision === "paid" ? opts.payoutCents! : null,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(creditInsuranceClaims.id, opts.claimId),
      eq(creditInsuranceClaims.tenantId, opts.tenantId),
      inArray(creditInsuranceClaims.status, ["filed", "under_review"]), // claim-first settle
    ))
    .returning()) as unknown as (typeof creditInsuranceClaims.$inferSelect)[];
  const claim = flipped[0] ?? ((await db
    .select()
    .from(creditInsuranceClaims)
    .where(and(eq(creditInsuranceClaims.id, opts.claimId), eq(creditInsuranceClaims.tenantId, opts.tenantId)))
    .limit(1)) as unknown as (typeof creditInsuranceClaims.$inferSelect)[])[0];
  if (flipped.length > 0 && claim) {
    await db
      .update(creditInsurancePolicies)
      .set({ status: "claimed", updatedAt: now })
      .where(and(eq(creditInsurancePolicies.id, claim.policyId), eq(creditInsurancePolicies.status, "bound")));
  }
  return { ok: !!claim, changed: flipped.length > 0, claim };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listPolicies(db: DbHandle, tenantId: string, limit = 50) {
  return (await db
    .select()
    .from(creditInsurancePolicies)
    .where(eq(creditInsurancePolicies.tenantId, tenantId))
    .orderBy(desc(creditInsurancePolicies.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)))) as unknown as (typeof creditInsurancePolicies.$inferSelect)[];
}

export async function listClaims(db: DbHandle, tenantId: string, limit = 50) {
  return (await db
    .select()
    .from(creditInsuranceClaims)
    .where(eq(creditInsuranceClaims.tenantId, tenantId))
    .orderBy(desc(creditInsuranceClaims.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)))) as unknown as (typeof creditInsuranceClaims.$inferSelect)[];
}
// === END W57 risk-shield ===
