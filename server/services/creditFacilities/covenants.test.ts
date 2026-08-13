/**
 * W14 F4 — covenant checks: utilization / NPL / single-buyer concentration
 * breach detection against covenants jsonb thresholds.
 */
import { describe, expect, it } from "vitest";
import {
  checkFacilityCovenants,
  evaluateCovenants,
  singleBuyerConcentrationPct,
} from "./covenants";
import { makeFakeDb, seedAccountExt, seedFacility, seedLedgerDue } from "./fakeDb";
import { FacilityNotFoundError } from "./facilities";
import { generateLoanBookTape } from "./tape";

const AS_OF = new Date("2025-03-15T00:00:00Z");
const daysAgo = (n: number) => new Date(AS_OF.getTime() - n * 24 * 60 * 60 * 1000);

describe("evaluateCovenants (pure)", () => {
  it("no thresholds → no breaches", () => {
    expect(evaluateCovenants({ utilizationPct: 99, nplPct: 99, singleBuyerPct: 99 }, {})).toEqual([]);
  });

  it("at-threshold is compliant; over breaches", () => {
    expect(
      evaluateCovenants({ utilizationPct: 80, nplPct: 5, singleBuyerPct: 25 }, {
        maxUtilizationPct: 80,
        maxNplPct: 5,
        maxSingleBuyerPct: 25,
      }),
    ).toEqual([]);
    const breaches = evaluateCovenants({ utilizationPct: 80.1, nplPct: 5.1, singleBuyerPct: 25.1 }, {
      maxUtilizationPct: 80,
      maxNplPct: 5,
      maxSingleBuyerPct: 25,
    });
    expect(breaches.map((b) => b.covenant)).toEqual(["utilization", "npl", "singleBuyerConcentration"]);
    expect(breaches[0]).toMatchObject({ limitPct: 80, actualPct: 80.1 });
  });
});

describe("singleBuyerConcentrationPct", () => {
  it("max buyer share", () => {
    const m = new Map([
      ["b1", 100],
      ["b2", 300],
    ]);
    expect(singleBuyerConcentrationPct(m, 400)).toBeCloseTo(75);
  });
  it("empty book → 0", () => {
    expect(singleBuyerConcentrationPct(new Map(), 0)).toBe(0);
  });
});

describe("checkFacilityCovenants (fakeDb)", () => {
  it("compliant book → compliant, no breaches", async () => {
    const fac = seedFacility({
      id: "f1",
      commitmentCents: 1_000_000,
      covenants: { maxUtilizationPct: 80, maxNplPct: 5, maxSingleBuyerPct: 60 },
    });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ facilityId: "f1", buyerTenantId: "b1", outstandingCents: 200_000 }),
        seedAccountExt({ facilityId: "f1", buyerTenantId: "b2", outstandingCents: 200_000 }),
      ],
    });
    const res = await checkFacilityCovenants(db, "f1", { asOf: AS_OF });
    expect(res.compliant).toBe(true);
    expect(res.breaches).toEqual([]);
  });

  it("detects utilization breach", async () => {
    const fac = seedFacility({ id: "f1", commitmentCents: 100_000, covenants: { maxUtilizationPct: 50 } });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [seedAccountExt({ facilityId: "f1", outstandingCents: 60_000 })],
    });
    const res = await checkFacilityCovenants(db, "f1", { asOf: AS_OF });
    expect(res.compliant).toBe(false);
    expect(res.breaches).toEqual([{ covenant: "utilization", limitPct: 50, actualPct: 60 }]);
  });

  it("detects NPL breach from 90+ aged draws", async () => {
    const fac = seedFacility({ id: "f1", covenants: { maxNplPct: 10 } });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ id: "ok", facilityId: "f1", outstandingCents: 100 }),
        seedAccountExt({ id: "bad", facilityId: "f1", outstandingCents: 100 }),
      ],
      ledger: [seedLedgerDue("bad", { dueDate: daysAgo(120) })],
    });
    const res = await checkFacilityCovenants(db, "f1", { asOf: AS_OF });
    expect(res.compliant).toBe(false);
    expect(res.breaches).toHaveLength(1);
    expect(res.breaches[0].covenant).toBe("npl");
    expect(res.breaches[0].actualPct).toBeCloseTo(50);
  });

  it("detects single-buyer concentration breach across multiple accounts", async () => {
    const fac = seedFacility({ id: "f1", covenants: { maxSingleBuyerPct: 50 } });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ facilityId: "f1", buyerTenantId: "big", outstandingCents: 400 }),
        seedAccountExt({ facilityId: "f1", buyerTenantId: "big", outstandingCents: 300 }),
        seedAccountExt({ facilityId: "f1", buyerTenantId: "small", outstandingCents: 300 }),
      ],
    });
    const res = await checkFacilityCovenants(db, "f1", { asOf: AS_OF });
    expect(res.compliant).toBe(false);
    expect(res.breaches[0].covenant).toBe("singleBuyerConcentration");
    expect(res.breaches[0].actualPct).toBeCloseTo(70);
  });

  // W14.1 — the singleBuyer numerator comes from the SAME asOf snapshot as
  // the denominator (tape rows), not a current-state account query.
  it("singleBuyerPct numerator derives from the tape rows (same asOf snapshot as the denominator)", async () => {
    const fac = seedFacility({ id: "f1", covenants: { maxSingleBuyerPct: 50 } });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ id: "a1", facilityId: "f1", buyerTenantId: "big", outstandingCents: 400 }),
        seedAccountExt({ id: "a2", facilityId: "f1", buyerTenantId: "big", outstandingCents: 300 }),
        seedAccountExt({ id: "a3", facilityId: "f1", buyerTenantId: "small", outstandingCents: 300 }),
      ],
    });
    const res = await checkFacilityCovenants(db, "f1", { asOf: AS_OF });
    // Recompute the expectation straight from the tape snapshot.
    const tape = await generateLoanBookTape(db, { facilityId: "f1", asOf: AS_OF });
    const byBuyer = new Map<string, number>();
    for (const r of tape.rows) byBuyer.set(r.buyerTenantId, (byBuyer.get(r.buyerTenantId) ?? 0) + r.outstandingCents);
    const expected = singleBuyerConcentrationPct(byBuyer, tape.summary.totalOutstandingCents);
    expect(res.breaches[0].actualPct).toBeCloseTo(expected);
    // Sanity: the tape-derived numerator (700) is what the 70% comes from.
    expect(res.breaches[0].actualPct).toBeCloseTo(70);
  });

  it("throws for unknown facility", async () => {
    const { db } = makeFakeDb();
    await expect(checkFacilityCovenants(db, "nope")).rejects.toBeInstanceOf(FacilityNotFoundError);
  });
});
