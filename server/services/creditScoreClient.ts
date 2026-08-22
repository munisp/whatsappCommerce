/**
 * W27 — Platform merchant credit score CLIENT (thin re-export).
 *
 * Post-merge (Wave 27): D's server/services/creditScore.ts is now in tree,
 * so the standalone import-guard/fallback has been removed per the merge
 * playbook. `getMerchantScoreGuarded` is kept as a stable accessor for
 * F's wholesale callers; it delegates directly to D's frozen contract
 * `getMerchantScore(tenantId, merchantId, db)` with 0–1000 clamping.
 */
import { getMerchantScore, type MerchantScoreResult } from "./creditScore";
import type { DbHandle } from "./tradeCredit/accounts";

export type { MerchantScoreResult, MerchantScoreFactors } from "./creditScore";

/**
 * Contract-stable accessor. `tenantId` is the platform tenant context,
 * `merchantId` the merchant (tenant) being scored — matches D's signature.
 */
export async function getMerchantScoreGuarded(
  tenantId: string,
  merchantId: string,
  db: DbHandle,
): Promise<MerchantScoreResult> {
  const r = await getMerchantScore(tenantId, merchantId, db);
  return { ...r, score: Math.max(0, Math.min(1000, Math.round(r.score))) };
}

/** @deprecated No-op retained for callers of the old import-guard test hook. */
export function __resetCreditScoreResolution(): void {
  // Guard removed post-merge — nothing to reset.
}
