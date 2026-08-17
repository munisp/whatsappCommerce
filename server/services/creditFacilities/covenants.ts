/**
 * W14 F4 — facility covenant monitoring.
 *
 * A facility's `covenants` jsonb carries lender-imposed thresholds:
 *   { maxUtilizationPct?, maxNplPct?, maxSingleBuyerPct? }
 * checkFacilityCovenants measures the assigned book against each threshold
 * and reports every breach. All comparisons are percentage points (0-100),
 * computed from integer cents.
 */
import { FacilityNotFoundError, getFacilityById, getFacilityUtilization, type TxHandle } from "./facilities";
import { generateLoanBookTape } from "./tape";

export interface CovenantThresholds {
  maxUtilizationPct?: number;
  maxNplPct?: number;
  maxSingleBuyerPct?: number;
}

export interface CovenantBreach {
  covenant: "utilization" | "npl" | "singleBuyerConcentration";
  limitPct: number;
  actualPct: number;
}

export interface CovenantCheckResult {
  facilityId: string;
  compliant: boolean;
  breaches: CovenantBreach[];
}

export interface CovenantMetrics {
  utilizationPct: number;
  nplPct: number;
  singleBuyerPct: number;
}

/** Pure threshold evaluation — exported for unit tests. */
export function evaluateCovenants(metrics: CovenantMetrics, thresholds: CovenantThresholds): CovenantBreach[] {
  const breaches: CovenantBreach[] = [];
  if (thresholds.maxUtilizationPct != null && metrics.utilizationPct > thresholds.maxUtilizationPct) {
    breaches.push({ covenant: "utilization", limitPct: thresholds.maxUtilizationPct, actualPct: metrics.utilizationPct });
  }
  if (thresholds.maxNplPct != null && metrics.nplPct > thresholds.maxNplPct) {
    breaches.push({ covenant: "npl", limitPct: thresholds.maxNplPct, actualPct: metrics.nplPct });
  }
  if (thresholds.maxSingleBuyerPct != null && metrics.singleBuyerPct > thresholds.maxSingleBuyerPct) {
    breaches.push({
      covenant: "singleBuyerConcentration",
      limitPct: thresholds.maxSingleBuyerPct,
      actualPct: metrics.singleBuyerPct,
    });
  }
  return breaches;
}

/** Largest single buyer's share of outstanding (percentage points, 0 when empty). */
export function singleBuyerConcentrationPct(outstandingByBuyer: Map<string, number>, totalOutstandingCents: number): number {
  if (totalOutstandingCents <= 0) return 0;
  let max = 0;
  outstandingByBuyer.forEach((v) => { if (v > max) max = v; });
  return (max / totalOutstandingCents) * 100;
}

/**
 * Measure a facility's assigned book against its covenant thresholds.
 * Unknown/absent thresholds are simply not checked.
 */
export async function checkFacilityCovenants(
  db: TxHandle,
  facilityId: string,
  args: { asOf?: Date } = {},
): Promise<CovenantCheckResult> {
  const facility = await getFacilityById(db, facilityId);
  if (!facility) throw new FacilityNotFoundError(facilityId);
  const thresholds = ((facility.covenants ?? {}) as CovenantThresholds) ?? {};

  const utilization = await getFacilityUtilization(db, facilityId);
  const tape = await generateLoanBookTape(db, { facilityId, asOf: args.asOf });

  // W14.1: derive the singleBuyer numerator from the SAME asOf snapshot as
  // the denominator (tape rows). Previously the numerator came from a
  // current-state credit_accounts_ext query while the denominator was
  // asOf-sensitive — a backdated check mixed two points in time and could
  // over/under-state concentration.
  const outstandingByBuyer = new Map<string, number>();
  for (const r of tape.rows) {
    outstandingByBuyer.set(r.buyerTenantId, (outstandingByBuyer.get(r.buyerTenantId) ?? 0) + r.outstandingCents);
  }

  const metrics: CovenantMetrics = {
    utilizationPct: utilization.commitmentCents > 0 ? (utilization.outstandingCents / utilization.commitmentCents) * 100 : 0,
    nplPct: tape.summary.nplRatio * 100,
    singleBuyerPct: singleBuyerConcentrationPct(outstandingByBuyer, tape.summary.totalOutstandingCents),
  };
  const breaches = evaluateCovenants(metrics, thresholds);
  return { facilityId, compliant: breaches.length === 0, breaches };
}
