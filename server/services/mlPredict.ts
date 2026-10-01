// === W48 integrations ===
/**
 * mlPredict.ts — in-process ML fraud/credit scoring (PERF-INT-3).
 *
 * The order-create fraud gate used to call its OWN server over loopback HTTP
 * (`POST http://localhost:$PORT/api/ml/predict`) with no timeout — paying a
 * full HTTP round-trip per order, self-amplifying under load (the loopback
 * request competes for the same event loop as the request waiting on it),
 * and hanging as long as TCP kept the socket open.
 *
 * The scoring logic now lives here as a plain function. The HTTP route
 * (`/api/ml/predict`) and the NLP fraud gate BOTH call `predictMlScore`
 * directly — no self-HTTP hop. The function itself is bounded:
 *   - the FastAPI ml-stack probe uses AbortSignal.timeout(mlTimeoutMs)
 *     (default INTEGRATION_TIMEOUTS.fraudGate = 800ms on the order path —
 *     bounded fail-open, per audit: a hung ML stack must never stall order
 *     creation);
 *   - on any failure/timeout it falls back IN-PROCESS to the shared
 *     statistical heuristic (services/fraud.ts) — no second network call.
 */
import { INTEGRATION_TIMEOUTS } from "./net/resilientFetch";
import { assessFraudRisk } from "./fraud";

export interface MlPredictInput {
  tenantId?: string | null;
  amount: number;
  phone?: string | null;
  items?: unknown[] | null;
  customerId?: string | null;
}

export interface MlPredictResult {
  fraudProbability: number;
  creditScore: number;
  creditGrade?: string;
  riskLevel: string;
  modelVersion?: string;
  source: "ml-stack" | "fallback-heuristic";
}

/**
 * Score fraud/credit risk. Never throws; always returns within
 * ~opts.mlTimeoutMs when the ml-stack is unreachable (fail-open via the
 * in-process heuristic).
 */
export async function predictMlScore(
  input: MlPredictInput,
  opts: { mlTimeoutMs?: number; traceHeaders?: Record<string, string> } = {},
): Promise<MlPredictResult> {
  const numItems = Array.isArray(input.items) ? input.items.length : 0;
  const totalAmount = Number.isFinite(input.amount) ? input.amount : parseFloat(String(input.amount)) || 0;
  const mlStackUrl = process.env.ML_STACK_URL ?? "http://localhost:8099";
  const mlTimeoutMs = opts.mlTimeoutMs ?? 5_000;

  // 1. FastAPI inference server (CPU-optimized PyTorch/ONNX models) — bounded.
  try {
    const inferRes = await fetch(`${mlStackUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.traceHeaders ?? {}) },
      body: JSON.stringify({
        tenant_id: input.tenantId ?? null,
        amount: totalAmount,
        num_items: numItems,
        has_phone: !!input.phone,
        has_customer: !!input.customerId,
      }),
      signal: AbortSignal.timeout(mlTimeoutMs),
    });
    if (inferRes.ok) {
      const result = await inferRes.json() as {
        fraud_probability: number;
        credit_score: number;
        credit_grade?: string;
        risk_level: string;
        source?: string;
      };
      return {
        fraudProbability: result.fraud_probability,
        creditScore: result.credit_score,
        creditGrade: result.credit_grade,
        riskLevel: result.risk_level,
        modelVersion: result.source,
        source: "ml-stack",
      };
    }
    console.warn(`[ML] FastAPI inference server returned ${inferRes.status}, using fallback heuristic`);
  } catch (inferErr: any) {
    console.warn("[ML] FastAPI inference server unavailable, using fallback heuristic:", inferErr?.message);
  }

  // 2. In-process statistical fallback — identical to the pre-W48 behavior.
  const { fraudProbability, creditScore, riskLevel } = assessFraudRisk({
    amount: totalAmount,
    numItems,
    phone: input.phone ?? null,
    customerId: input.customerId ?? null,
  });
  return { fraudProbability, creditScore, riskLevel, source: "fallback-heuristic" };
}

export { INTEGRATION_TIMEOUTS };
