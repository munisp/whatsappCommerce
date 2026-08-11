/**
 * KYB compliance orchestration (wave 12).
 *
 * `runKybChecks` combines business-registry verification and sanctions
 * screening into a single ADVISORY recommendation. The recommendation only
 * pre-fills the admin review queue — a human admin still clicks approve.
 *
 * Decision matrix:
 *   sanctions.hit (non-degraded)        → reject
 *   sanctions degraded                  → manual_review
 *   registry unavailable | not_found    → manual_review
 *   registry mismatch                   → manual_review
 *   registry verified + no sanctions hit → auto_approve
 *
 * Integration points (server/routers/kyc.ts is owned by another agent — do
 * NOT edit it; wire these exports there):
 *   - after kyc.updateApplication fills businessName /
 *     businessRegistrationNumber / businessCountry, call runKybChecks and
 *     persist the recommendation on the application record;
 *   - kyc.submit should block auto-submit when recommendation === 'reject';
 *   - admin review queue reads `reasons` to show the reviewer why.
 */

import { verifyBusinessRegistration, type RegistryVerifyResult } from "./registryVerify";
import { screenEntity, type SanctionsScreenResult } from "./sanctions";
import type { HttpClient } from "./fakeHttp";

export * from "./registryVerify";
export * from "./sanctions";
export * from "./fakeHttp";

export type KybRecommendation = "auto_approve" | "manual_review" | "reject";

export interface TenantDraft {
  businessName: string;
  registrationNumber: string;
  country: string;
}

export interface KybCheckResult {
  registry: RegistryVerifyResult;
  sanctions: SanctionsScreenResult;
  recommendation: KybRecommendation;
  reasons: string[];
}

export async function runKybChecks(
  tenantDraft: TenantDraft,
  deps: { env?: NodeJS.ProcessEnv; http?: HttpClient } = {},
): Promise<KybCheckResult> {
  const registry = await verifyBusinessRegistration(
    {
      registrationNumber: tenantDraft.registrationNumber,
      businessName: tenantDraft.businessName,
      country: tenantDraft.country,
    },
    deps,
  );
  const sanctions = await screenEntity(
    { name: tenantDraft.businessName, registrationNumber: tenantDraft.registrationNumber },
    deps,
  );

  const reasons: string[] = [];
  let recommendation: KybRecommendation;

  if (sanctions.degraded) {
    recommendation = "manual_review";
    reasons.push("sanctions screening degraded (list unavailable) — manual review required");
  } else if (sanctions.hit) {
    recommendation = "reject";
    reasons.push(
      `sanctions hit: ${sanctions.matches
        .slice(0, 3)
        .map((m) => `${m.name} (${m.list}, score ${m.score.toFixed(2)})`)
        .join("; ")}`,
    );
  } else {
    switch (registry.status) {
      case "verified":
        recommendation = "auto_approve";
        reasons.push(`registry verified via ${registry.provider}`);
        reasons.push("no sanctions hits");
        break;
      case "mismatch":
        recommendation = "manual_review";
        reasons.push(
          `registry name mismatch (submitted "${tenantDraft.businessName}", registry "${registry.matchedName ?? "unknown"}")`,
        );
        break;
      case "not_found":
        recommendation = "manual_review";
        reasons.push(`registration number not found in ${registry.provider} registry`);
        break;
      default:
        recommendation = "manual_review";
        reasons.push(`registry provider ${registry.provider} unavailable`);
    }
  }

  return { registry, sanctions, recommendation, reasons };
}
