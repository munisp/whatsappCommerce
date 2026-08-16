/**
 * CV-1 unit tests — active-learning export prioritization.
 *
 * Pure-function coverage of computeExportPriority (services/activeLearning.ts):
 * corrected sessions outrank uncorrected (+2.0), low-confidence sessions get
 * the +1.0 bonus, recency decays exponentially — and the composed ordering
 * used by the Label Studio export is asserted explicitly so a revert of any
 * term fails these tests.
 */
import { describe, it, expect } from "vitest";
import {
  computeExportPriority,
  PRIORITY_CORRECTED_BONUS,
  PRIORITY_LOW_CONFIDENCE_BONUS,
  PRIORITY_RECENCY_DECAY_DAYS,
} from "./activeLearning";

const NOW = 1_800_000_000_000; // fixed clock
const day = 24 * 60 * 60 * 1000;

describe("computeExportPriority", () => {
  it("plain fresh session scores 1.0", () => {
    const s = computeExportPriority({
      hasCorrections: false,
      minConfidence: 0.9,
      reviewThreshold: 0.6,
      createdAt: NOW,
      now: NOW,
    });
    expect(s).toBe(1);
  });

  it("corrected session gets the +2.0 bonus", () => {
    const s = computeExportPriority({
      hasCorrections: true,
      minConfidence: 0.9,
      reviewThreshold: 0.6,
      createdAt: NOW,
      now: NOW,
    });
    expect(s).toBe(1 + PRIORITY_CORRECTED_BONUS);
    expect(s).toBe(3);
  });

  it("low-confidence (< review threshold) gets the +1.0 bonus", () => {
    const s = computeExportPriority({
      hasCorrections: false,
      minConfidence: 0.42,
      reviewThreshold: 0.6,
      createdAt: NOW,
      now: NOW,
    });
    expect(s).toBe(1 + PRIORITY_LOW_CONFIDENCE_BONUS);
    expect(s).toBe(2);
  });

  it("confidence exactly AT the threshold gets no bonus", () => {
    const s = computeExportPriority({
      hasCorrections: false,
      minConfidence: 0.6,
      reviewThreshold: 0.6,
      createdAt: NOW,
      now: NOW,
    });
    expect(s).toBe(1);
  });

  it("both bonuses stack", () => {
    const s = computeExportPriority({
      hasCorrections: true,
      minConfidence: 0.1,
      reviewThreshold: 0.6,
      createdAt: NOW,
      now: NOW,
    });
    expect(s).toBe(4);
  });

  it("recency decay: older sessions score strictly lower (exp decay)", () => {
    const fresh = computeExportPriority({
      hasCorrections: true, minConfidence: 0.9, reviewThreshold: 0.6, createdAt: NOW, now: NOW,
    });
    const aged = computeExportPriority({
      hasCorrections: true, minConfidence: 0.9, reviewThreshold: 0.6,
      createdAt: NOW - PRIORITY_RECENCY_DECAY_DAYS * day, now: NOW,
    });
    expect(aged).toBeLessThan(fresh);
    expect(aged).toBeCloseTo(3 * Math.exp(-1), 4);
  });

  it("composed ordering: corrected+low-conf > corrected > low-conf fresh > plain fresh > plain old", () => {
    const mk = (over: Partial<Parameters<typeof computeExportPriority>[0]>) =>
      computeExportPriority({
        hasCorrections: false, minConfidence: 0.95, reviewThreshold: 0.6,
        createdAt: NOW, now: NOW, ...over,
      });
    const scores = {
      correctedLowConf: mk({ hasCorrections: true, minConfidence: 0.3 }),
      corrected: mk({ hasCorrections: true }),
      lowConf: mk({ minConfidence: 0.3 }),
      plain: mk({}),
      plainOld: mk({ createdAt: NOW - 90 * day }),
    };
    const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    expect(ordered).toEqual(["correctedLowConf", "corrected", "lowConf", "plain", "plainOld"]);
  });
});
