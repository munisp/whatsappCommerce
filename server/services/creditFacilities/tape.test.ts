/**
 * W14 F4 — loan-book tape: dpd bucketing boundaries, NPL ratio, weighted
 * score, CSV rendering, consent/mandate/facility fields, email preview.
 */
import { describe, expect, it } from "vitest";
import {
  bucketForDpd,
  buildTapeRows,
  generateLoanBookTape,
  summarizeTape,
  tapeEmailPreview,
  tapeToCsv,
  TAPE_CSV_HEADER,
  type TapeRow,
} from "./tape";
import { makeFakeDb, seedAccountExt, seedFacility, seedLedgerDue } from "./fakeDb";
import { FacilityNotFoundError } from "./facilities";

const AS_OF = new Date("2025-03-15T00:00:00Z");
const daysAgo = (n: number) => new Date(AS_OF.getTime() - n * 24 * 60 * 60 * 1000);

describe("bucketForDpd boundaries", () => {
  it.each([
    [-5, "current"],
    [0, "current"],
    [1, "1-30"],
    [30, "1-30"],
    [31, "31-60"],
    [60, "31-60"],
    [61, "61-90"],
    [90, "61-90"],
    [91, "90+"],
    [400, "90+"],
  ] as const)("dpd=%i → %s", (dpd, bucket) => {
    expect(bucketForDpd(dpd)).toBe(bucket);
  });
});

describe("summarizeTape", () => {
  const row = (over: Partial<TapeRow>): TapeRow => ({
    accountId: "a",
    buyerTenantId: "b",
    supplierTenantId: "s",
    limitCents: 0,
    outstandingCents: 0,
    score: null,
    dpd: 0,
    bucket: "current",
    bureauConsent: false,
    mandateStatus: "none",
    facilityRef: null,
    ...over,
  });

  it("NPL ratio is the 90+ outstanding share", () => {
    const s = summarizeTape([
      row({ accountId: "1", outstandingCents: 100, bucket: "current" }),
      row({ accountId: "2", outstandingCents: 300, bucket: "90+" }),
    ]);
    expect(s.totalOutstandingCents).toBe(400);
    expect(s.nplRatio).toBeCloseTo(0.75);
    expect(s.accountCount).toBe(2);
  });

  it("weightedScore is outstanding-weighted over scored accounts only", () => {
    const s = summarizeTape([
      row({ accountId: "1", outstandingCents: 100, score: 50 }),
      row({ accountId: "2", outstandingCents: 300, score: 80 }),
      row({ accountId: "3", outstandingCents: 900, score: null }), // unscored ignored
    ]);
    expect(s.weightedScore).toBeCloseTo((50 * 100 + 80 * 300) / 400);
  });

  it("empty book → 0 totals, null score, 0 NPL", () => {
    expect(summarizeTape([])).toEqual({ accountCount: 0, totalOutstandingCents: 0, weightedScore: null, nplRatio: 0 });
  });
});

describe("buildTapeRows (pure)", () => {
  it("dpd uses the oldest unpaid draw; consent and mandate fields populated", () => {
    const rows = buildTapeRows({
      accounts: [
        {
          id: "a1",
          buyerTenantId: "b1",
          supplierTenantId: "s1",
          limitCents: 100,
          outstandingCents: 50,
          score: 70,
          mandateId: "m1",
          bureauConsentAt: new Date("2025-01-01"),
          facilityId: "f1",
        },
      ],
      dueDatesByAccount: new Map([["a1", [daysAgo(45), daysAgo(10)]]]),
      mandateStatusById: new Map([["m1", "active"]]),
      facilityRefById: new Map([["f1", "FAC-1"]]),
      asOf: AS_OF,
    });
    expect(rows[0].dpd).toBe(45);
    expect(rows[0].bucket).toBe("31-60");
    expect(rows[0].bureauConsent).toBe(true);
    expect(rows[0].mandateStatus).toBe("active");
    expect(rows[0].facilityRef).toBe("FAC-1");
  });

  it("no consent → false; no mandate → 'none'; unassigned → null ref", () => {
    const rows = buildTapeRows({
      accounts: [
        {
          id: "a1",
          buyerTenantId: "b1",
          supplierTenantId: "s1",
          limitCents: 100,
          outstandingCents: 0,
          score: null,
          mandateId: null,
          bureauConsentAt: null,
          facilityId: null,
        },
      ],
      dueDatesByAccount: new Map(),
      mandateStatusById: new Map(),
      facilityRefById: new Map(),
      asOf: AS_OF,
    });
    expect(rows[0]).toMatchObject({ dpd: 0, bucket: "current", bureauConsent: false, mandateStatus: "none", facilityRef: null });
  });

  it("sorts worst delinquency first", () => {
    const mk = (id: string) => ({
      id,
      buyerTenantId: "b",
      supplierTenantId: "s",
      limitCents: 1,
      outstandingCents: 1,
      score: null,
      mandateId: null,
      bureauConsentAt: null,
      facilityId: null,
    });
    const rows = buildTapeRows({
      accounts: [mk("a1"), mk("a2"), mk("a3")],
      dueDatesByAccount: new Map([
        ["a2", [daysAgo(95)]],
        ["a3", [daysAgo(5)]],
      ]),
      mandateStatusById: new Map(),
      facilityRefById: new Map(),
      asOf: AS_OF,
    });
    expect(rows.map((r) => r.accountId)).toEqual(["a2", "a3", "a1"]);
  });
});

describe("generateLoanBookTape (fakeDb)", () => {
  it("facility filter restricts rows and sets facilityRef", async () => {
    const fac = seedFacility({ id: "f1", facilityRef: "FAC-ALPHA" });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ id: "a1", facilityId: "f1", outstandingCents: 10_000 }),
        seedAccountExt({ id: "a2", facilityId: "f2", outstandingCents: 20_000 }),
      ],
    });
    const tape = await generateLoanBookTape(db, { facilityId: "f1", asOf: AS_OF });
    expect(tape.facilityRef).toBe("FAC-ALPHA");
    expect(tape.rows.map((r) => r.accountId)).toEqual(["a1"]);
    expect(tape.summary.totalOutstandingCents).toBe(10_000);
  });

  it("unknown facility throws", async () => {
    const { db } = makeFakeDb();
    await expect(generateLoanBookTape(db, { facilityId: "nope" })).rejects.toBeInstanceOf(FacilityNotFoundError);
  });

  it("whole-book tape ages buckets from posted draws and joins mandates/facilities", async () => {
    const fac = seedFacility({ id: "f1", facilityRef: "FAC-1" });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ id: "cur", outstandingCents: 100, facilityId: "f1", bureauConsentAt: new Date() }),
        seedAccountExt({ id: "mid", outstandingCents: 200, mandateId: "m1" }),
        seedAccountExt({ id: "npl", outstandingCents: 400 }),
      ],
      mandates: [{ id: "m1", status: "revoked" }],
      ledger: [
        seedLedgerDue("cur", { dueDate: daysAgo(-10) }), // future due → current
        seedLedgerDue("mid", { dueDate: daysAgo(40) }),
        seedLedgerDue("npl", { dueDate: daysAgo(120) }),
        seedLedgerDue("npl", { dueDate: daysAgo(200), status: "settled" }), // settled ignored
      ],
    });
    const tape = await generateLoanBookTape(db, { asOf: AS_OF });
    const byId = Object.fromEntries(tape.rows.map((r) => [r.accountId, r]));
    expect(byId.cur.bucket).toBe("current");
    expect(byId.cur.bureauConsent).toBe(true);
    expect(byId.cur.facilityRef).toBe("FAC-1");
    expect(byId.mid.bucket).toBe("31-60");
    expect(byId.mid.mandateStatus).toBe("revoked");
    expect(byId.npl.bucket).toBe("90+");
    expect(tape.summary.nplRatio).toBeCloseTo(400 / 700);
    expect(tape.summary.accountCount).toBe(3);
  });
});

describe("tapeToCsv", () => {
  it("header + one line per row, escaped", () => {
    const rows = buildTapeRows({
      accounts: [
        {
          id: "a,1",
          buyerTenantId: 'b"1',
          supplierTenantId: "s1",
          limitCents: 100,
          outstandingCents: 50,
          score: null,
          mandateId: null,
          bureauConsentAt: new Date(),
          facilityId: null,
        },
      ],
      dueDatesByAccount: new Map(),
      mandateStatusById: new Map(),
      facilityRefById: new Map(),
      asOf: AS_OF,
    });
    const csv = tapeToCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(TAPE_CSV_HEADER);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"a,1"');
    expect(lines[1]).toContain('"b""1"');
    expect(csv.endsWith("\n")).toBe(true);
    // null score renders empty, booleans render true/false
    expect(lines[1]).toContain(",,0,current,true,none,");
  });
});

describe("tapeEmailPreview", () => {
  it("renders a plaintext lender summary", async () => {
    const fac = seedFacility({ id: "f1", lenderName: "Kuda MFB", facilityRef: "FAC-1", commitmentCents: 1_000_000_00 });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [seedAccountExt({ facilityId: "f1", outstandingCents: 250_000_00, score: 72 })],
    });
    const text = await tapeEmailPreview(db, "f1");
    expect(text).toContain("Kuda MFB");
    expect(text).toContain("FAC-1");
    expect(text).toContain("Accounts: 1");
    expect(text).toContain("NGN 250,000.00");
    expect(text).toContain("NPL ratio (90+): 0.00%");
    expect(text).toContain("current=1");
  });

  it("throws for unknown facility", async () => {
    const { db } = makeFakeDb();
    await expect(tapeEmailPreview(db, "nope")).rejects.toBeInstanceOf(FacilityNotFoundError);
  });
});
