/**
 * W14 F4 — facility CRUD, utilization math, advance-rate availability,
 * account assignment. Runs entirely on the in-memory fakeDb.
 */
import { describe, expect, it } from "vitest";
import {
  assignAccountToFacility,
  computeUtilization,
  createFacility,
  CreditAccountNotFoundError,
  FacilityNotFoundError,
  FacilityRefExistsError,
  getFacilityUtilization,
  listFacilities,
} from "./facilities";
import { makeFakeDb, seedAccountExt, seedFacility } from "./fakeDb";

describe("createFacility", () => {
  it("creates with defaults (NGN, 8000bps, active)", async () => {
    const { db } = makeFakeDb();
    const f = await createFacility(db, { lenderName: "Kuda MFB", facilityRef: "FAC-1", commitmentCents: 500_000_00 });
    expect(f.currency).toBe("NGN");
    expect(f.advanceRateBps).toBe(8000);
    expect(f.status).toBe("active");
    expect(f.commitmentCents).toBe(500_000_00);
  });

  it("rejects duplicate facilityRef", async () => {
    const { db } = makeFakeDb({ facilities: [seedFacility({ facilityRef: "FAC-1" })] });
    await expect(
      createFacility(db, { lenderName: "X", facilityRef: "FAC-1", commitmentCents: 1 }),
    ).rejects.toBeInstanceOf(FacilityRefExistsError);
  });

  it("rejects advanceRateBps > 10000", async () => {
    const { db } = makeFakeDb();
    await expect(
      createFacility(db, { lenderName: "X", facilityRef: "FAC-9", commitmentCents: 1, advanceRateBps: 10_001 }),
    ).rejects.toThrow(/advanceRateBps/);
  });
});

describe("assignAccountToFacility", () => {
  it("sets credit_accounts.facility_id", async () => {
    const fac = seedFacility({ id: "fac-1" });
    const acc = seedAccountExt({ id: "acc-1" });
    const { db, store } = makeFakeDb({ facilities: [fac], accounts: [acc] });
    const res = await assignAccountToFacility(db, { accountId: "acc-1", facilityId: "fac-1" });
    expect(res).toEqual({ accountId: "acc-1", facilityId: "fac-1" });
    expect(store.accounts[0].facilityId).toBe("fac-1");
  });

  it("throws when facility missing", async () => {
    const { db } = makeFakeDb({ accounts: [seedAccountExt({ id: "acc-1" })] });
    await expect(assignAccountToFacility(db, { accountId: "acc-1", facilityId: "nope" })).rejects.toBeInstanceOf(
      FacilityNotFoundError,
    );
  });

  it("throws when account missing", async () => {
    const { db } = makeFakeDb({ facilities: [seedFacility({ id: "fac-1" })] });
    await expect(assignAccountToFacility(db, { accountId: "nope", facilityId: "fac-1" })).rejects.toBeInstanceOf(
      CreditAccountNotFoundError,
    );
  });
});

describe("computeUtilization (pure)", () => {
  const fac = { id: "fac-1", commitmentCents: 1_000_000, advanceRateBps: 8000 };

  it("sums outstanding and computes bps", () => {
    const u = computeUtilization(fac, [250_000, 150_000]);
    expect(u.outstandingCents).toBe(400_000);
    expect(u.accountCount).toBe(2);
    expect(u.utilizationBps).toBe(4000); // 40%
  });

  it("availableToAdvance = commitment*rate − outstanding", () => {
    const u = computeUtilization(fac, [500_000]);
    expect(u.availableToAdvanceCents).toBe(800_000 - 500_000);
  });

  it("availableToAdvance floors at 0 beyond the advance rate", () => {
    const u = computeUtilization(fac, [900_000]);
    expect(u.availableToAdvanceCents).toBe(0);
  });

  it("zero commitment → 0 bps and 0 headroom", () => {
    const u = computeUtilization({ ...fac, commitmentCents: 0 }, [100]);
    expect(u.utilizationBps).toBe(0);
    expect(u.availableToAdvanceCents).toBe(0);
  });

  it("100% utilization is 10000 bps", () => {
    expect(computeUtilization(fac, [1_000_000]).utilizationBps).toBe(10_000);
  });

  it("rounds sub-cent advance capacity down", () => {
    const u = computeUtilization({ id: "f", commitmentCents: 101, advanceRateBps: 5000 }, []);
    expect(u.availableToAdvanceCents).toBe(50); // floor(50.5)
  });
});

describe("getFacilityUtilization / listFacilities", () => {
  it("aggregates only accounts assigned to the facility", async () => {
    const fac = seedFacility({ id: "fac-1", commitmentCents: 1_000_000, advanceRateBps: 7500 });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [
        seedAccountExt({ facilityId: "fac-1", outstandingCents: 100_000 }),
        seedAccountExt({ facilityId: "fac-1", outstandingCents: 50_000 }),
        seedAccountExt({ facilityId: "fac-other", outstandingCents: 999_000 }),
        seedAccountExt({ facilityId: null, outstandingCents: 888_000 }),
      ],
    });
    const u = await getFacilityUtilization(db, "fac-1");
    expect(u.accountCount).toBe(2);
    expect(u.outstandingCents).toBe(150_000);
    expect(u.utilizationBps).toBe(1500);
    expect(u.availableToAdvanceCents).toBe(750_000 - 150_000);
  });

  it("throws for unknown facility", async () => {
    const { db } = makeFakeDb();
    await expect(getFacilityUtilization(db, "nope")).rejects.toBeInstanceOf(FacilityNotFoundError);
  });

  it("listFacilities returns each facility with its own utilization", async () => {
    const { db } = makeFakeDb({
      facilities: [
        seedFacility({ id: "fac-1", commitmentCents: 1_000_000 }),
        seedFacility({ id: "fac-2", commitmentCents: 2_000_000, advanceRateBps: 5000 }),
      ],
      accounts: [
        seedAccountExt({ facilityId: "fac-1", outstandingCents: 500_000 }),
        seedAccountExt({ facilityId: "fac-2", outstandingCents: 1_000_000 }),
      ],
    });
    const list = await listFacilities(db);
    expect(list).toHaveLength(2);
    const f1 = list.find((f) => f.id === "fac-1")!;
    const f2 = list.find((f) => f.id === "fac-2")!;
    expect(f1.utilization.utilizationBps).toBe(5000);
    expect(f2.utilization.utilizationBps).toBe(5000);
    expect(f2.utilization.availableToAdvanceCents).toBe(0); // 50% rate ⇒ cap 1_000_000
  });

  it("listFacilities on empty book returns []", async () => {
    const { db } = makeFakeDb();
    expect(await listFacilities(db)).toEqual([]);
  });
});
