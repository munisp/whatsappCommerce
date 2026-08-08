/**
 * Shared fraud-risk heuristic — the same statistical fallback used by
 * POST /api/ml/predict when the FastAPI ML stack is unreachable. Extracted so
 * the payment path and the ML proxy score identically.
 *
 * Calibrated against Nigerian e-commerce fraud patterns (see
 * server/_core/index.ts /api/ml/predict).
 */

/** Scores at or above this are "high" risk and must be flagged + cased. */
export const FRAUD_HIGH_RISK_THRESHOLD = 0.7;
export const FRAUD_MEDIUM_RISK_THRESHOLD = 0.4;

export interface FraudRiskInput {
  amount: number;
  numItems?: number;
  phone?: string | null;
  customerId?: string | null;
}

export interface FraudRiskResult {
  fraudProbability: number;
  creditScore: number;
  riskLevel: "low" | "medium" | "high";
}

export function assessFraudRisk(input: FraudRiskInput): FraudRiskResult {
  const totalAmount = Number.isFinite(input.amount) ? input.amount : 0;
  const numItems = input.numItems ?? 0;
  let riskScore = 0.05; // base fraud rate
  if (totalAmount > 500_000) riskScore += 0.40;
  else if (totalAmount > 100_000) riskScore += 0.20;
  else if (totalAmount > 50_000) riskScore += 0.10;
  if (numItems > 50) riskScore += 0.25;
  else if (numItems > 20) riskScore += 0.12;
  if (!input.phone || String(input.phone).length < 10) riskScore += 0.30;
  if (!input.customerId) riskScore += 0.15;
  if (totalAmount === 0) riskScore += 0.50;
  const fraudProbability = Math.min(0.99, Math.max(0.01, riskScore));
  const creditScore = Math.round(850 - fraudProbability * 550);
  const riskLevel =
    fraudProbability > FRAUD_HIGH_RISK_THRESHOLD ? "high"
    : fraudProbability > FRAUD_MEDIUM_RISK_THRESHOLD ? "medium"
    : "low";
  return { fraudProbability, creditScore, riskLevel };
}
