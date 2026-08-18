/**
 * W20 mlLeadScoring unit tests — pure logistic-regression math (determinism,
 * convergence, L2 shrinkage), minimum-sample gate, rules-fallback contract,
 * and ML-vs-rules scoring with a mocked db.
 */
import { describe, it, expect } from "vitest";
import {
  ML_FEATURE_NAMES,
  ML_MODEL_PARAMS,
  mulberry32,
  sigmoid,
  predictPropensity,
  meanLogLoss,
  trainLogisticRegression,
  scoreCustomerMl,
  trainLeadModelTx,
  type TrainingRow,
} from "./mlLeadScoring";

/** Separable synthetic set: high x0 → y=1, low x0 → y=0. */
function separableRows(n: number): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (let i = 0; i < n; i++) {
    const hi = i % 2 === 0;
    rows.push({
      x: [hi ? 0.9 : 0.1, hi ? 0.8 : 0.2, 0.5, 0.4, hi ? 0.7 : 0.1, 0, 0],
      y: hi ? 1 : 0,
    });
  }
  return rows;
}

describe("sigmoid / mulberry32", () => {
  it("sigmoid(0)=0.5, monotonic, symmetric", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(10)).toBeGreaterThan(0.9999);
    expect(sigmoid(-10)).toBeLessThan(0.0001);
    expect(sigmoid(2)).toBeCloseTo(1 - sigmoid(-2), 12);
  });

  it("mulberry32 is deterministic and in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("trainLogisticRegression", () => {
  it("converges: separates the classes with positive-class propensity > negative", () => {
    const rows = separableRows(60);
    const { weights, logloss } = trainLogisticRegression(rows);
    const pHi = predictPropensity(weights, rows[0].x); // y=1
    const pLo = predictPropensity(weights, rows[1].x); // y=0
    expect(pHi).toBeGreaterThan(0.9);
    expect(pLo).toBeLessThan(0.1);
    expect(logloss).toBeLessThan(0.2);
    expect(weights.length).toBe(ML_FEATURE_NAMES.length + 1);
  });

  it("is deterministic: same rows + default seed → identical weights", () => {
    const rows = separableRows(60);
    const a = trainLogisticRegression(rows);
    const b = trainLogisticRegression(rows);
    expect(a.weights).toEqual(b.weights);
    expect(a.logloss).toBe(b.logloss);
  });

  it("different seeds initialize differently but still converge", () => {
    const rows = separableRows(60);
    const a = trainLogisticRegression(rows, { seed: 1 });
    const b = trainLogisticRegression(rows, { seed: 2 });
    expect(a.weights).not.toEqual(b.weights);
    expect(predictPropensity(a.weights, rows[0].x)).toBeGreaterThan(0.9);
    expect(predictPropensity(b.weights, rows[0].x)).toBeGreaterThan(0.9);
  });

  it("L2 regularization shrinks weights vs unregularized", () => {
    const rows = separableRows(60);
    const reg = trainLogisticRegression(rows, { l2: 0.05 });
    const unreg = trainLogisticRegression(rows, { l2: 0 });
    const norm = (w: number[]) => Math.sqrt(w.reduce((s, v) => s + v * v, 0));
    expect(norm(reg.weights)).toBeLessThan(norm(unreg.weights));
  });

  it("empty training set is a no-op (logloss 0)", () => {
    const { logloss, weights } = trainLogisticRegression([]);
    expect(logloss).toBe(0);
    expect(weights.length).toBe(ML_FEATURE_NAMES.length + 1);
  });
});

describe("meanLogLoss", () => {
  it("perfect predictions → ~0, wrong predictions → large", () => {
    const w = [0, 20, 0, 0, 0, 0, 0, 0];
    const good: TrainingRow[] = [{ x: [1, 0, 0, 0, 0, 0, 0], y: 1 }];
    const bad: TrainingRow[] = [{ x: [1, 0, 0, 0, 0, 0, 0], y: 0 }];
    expect(meanLogLoss(w, good)).toBeLessThan(0.001);
    expect(meanLogLoss(w, bad)).toBeGreaterThan(10);
  });
});

// ─── db-mocked contract tests ────────────────────────────────────────────────

/** Universal thenable chain returning `rows` for any select path. */
function chainTo(rows: any[]): any {
  return new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: any) => res(rows) : () => chainTo(rows)),
    apply: () => chainTo(rows),
  }) as any;
}

const HOT_CUSTOMER = {
  id: "c1", whatsappPhone: "2341", totalOrders: 6,
  totalSpent: "120000.00", lastOrderAt: new Date(),
};

describe("scoreCustomerMl fallback contract", () => {
  it("no trained model → fallbackUsed=true, propensity from rule score, never throws", async () => {
    // loadLatestModel → []; rules path then gets the customer row and zeros elsewhere.
    const db = {
      select: () => chainTo([HOT_CUSTOMER]), // leadScoreModels select ALSO returns this →
    } as any;
    // weights field missing → malformed model → fallback; must not throw.
    const r = await scoreCustomerMl(db, "t1", "c1");
    expect(r.fallbackUsed).toBe(true);
    expect(r.modelVersion).toBeNull();
    expect(r.propensity).toBeGreaterThanOrEqual(0);
    expect(r.propensity).toBeLessThanOrEqual(1);
  });

  it("db explosion → fallbackUsed=true with propensity 0, does not throw", async () => {
    const db = {
      select: () => { throw new Error("db down"); },
    } as any;
    const r = await scoreCustomerMl(db, "t1", "c1");
    expect(r).toEqual({ propensity: 0, confidence: 0, fallbackUsed: true, modelVersion: null });
  });

  it("trained model → fallbackUsed=false, propensity in (0,1), modelVersion set", async () => {
    // Trained weights that strongly favor the hot customer's features.
    const weights = [-2, 3, 3, 2, 1, 1, 0, 0];
    const modelRow = {
      id: "m1", tenantId: "t1", weights, featureNames: [...ML_FEATURE_NAMES],
      trainedAt: new Date(), sampleCount: 120, logloss: 0.2, version: 3,
    };
    let call = 0;
    const db = {
      select: () => {
        call += 1;
        // 1st select = loadLatestModel, 2nd = customer, rest = features queries
        return chainTo(call === 1 ? [modelRow] : call === 2 ? [HOT_CUSTOMER] : [{ n: 5, createdAt: new Date(), cents: 12_000_000, limit: 0, outstanding: 0 }]);
      },
    } as any;
    const r = await scoreCustomerMl(db, "t1", "c1");
    expect(r.fallbackUsed).toBe(false);
    expect(r.modelVersion).toBe(3);
    expect(r.propensity).toBeGreaterThan(0.5);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("malformed model (wrong weights length) → rules fallback", async () => {
    const modelRow = {
      id: "m1", tenantId: "t1", weights: [1, 2], featureNames: [],
      trainedAt: new Date(), sampleCount: 10, logloss: 1, version: 1,
    };
    const db = { select: () => chainTo([modelRow]) } as any;
    const r = await scoreCustomerMl(db, "t1", "c1");
    expect(r.fallbackUsed).toBe(true);
  });
});

describe("trainLeadModelTx minimum-sample gate", () => {
  it("below minTrainSamples → trained=false, no insert attempted", async () => {
    const customersRows = Array.from({ length: ML_MODEL_PARAMS.minTrainSamples - 1 }, (_, i) => ({
      id: `c${i}`, whatsappPhone: `p${i}`, totalOrders: 1, totalSpent: "10.00", lastOrderAt: new Date(),
    }));
    let inserted = false;
    let call = 0;
    const db = {
      select: () => {
        call += 1;
        // first select = customers list; subsequent = order counts (pre=1, post=0) / feature queries
        // every count query returns 1 → each customer yields one labeled row
        return chainTo(call === 1 ? customersRows : [{ n: 1, createdAt: new Date(Date.now() - 30 * 86400000), cents: 1000 }]);
      },
      insert: () => { inserted = true; return { values: () => Promise.resolve([]) }; },
    } as any;
    const r = await trainLeadModelTx(db, "t1", new Date());
    expect(r.trained).toBe(false);
    expect(r.reason).toBe("insufficient_samples");
    expect(r.sampleCount).toBe(ML_MODEL_PARAMS.minTrainSamples - 1);
    expect(r.version).toBeNull();
    expect(inserted).toBe(false);
  });
});
