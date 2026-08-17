/**
 * W13 limit revision — scorer-driven re-underwriting with immediate downward
 * application, clamp-at-outstanding, and credit_limit_history audit rows.
 */
import { describe, it, expect } from "vitest";
import { makeFakeDb, seedAccount, seedDraw } from "./fakeDb";
import { reviseLimitsTx } from "./limits";
import { FLOOR_LIMIT_CENTS } from "./scoring";

const NOW = new Date("2025-03-10T12:00:00Z");

/** No orders/payments ⇒ cold-start suggestion = FLOOR_LIMIT_CENTS (₦50k). */
function coldDb(accountOverrides: Record<string, unknown>) {
  const account = seedAccount({ id: "acct-1", ...accountOverrides });
  return makeFakeDb({ accounts: [account] });
}

describe("reviseLimitsTx — downward revision", () => {
  it("applies a downward revision immediately and records auto_revision history", async () => {
    const { db, store } = coldDb({ limitCents: 10_000_000, outstandingCents: 0 });
    const res = await reviseLimitsTx(db, { accountId: "acct-1" }, NOW);
    expect(res).toMatchObject({
      ok: true,
      changed: true,
      oldLimitCents: 10_000_000,
      newLimitCents: FLOOR_LIMIT_CENTS,
      suggestedLimitCents: FLOOR_LIMIT_CENTS,
      clampedAtOutstanding: false,
      reason: "auto_revision",
    });
    expect(store.accounts[0].limitCents).toBe(FLOOR_LIMIT_CENTS);
    expect(store.limitHistory).toHaveLength(1);
    expect(store.limitHistory[0]).toMatchObject({
      accountId: "acct-1",
      oldLimitCents: 10_000_000,
      newLimitCents: FLOOR_LIMIT_CENTS,
      reason: "auto_revision",
    });
  });

  it("clamps at outstanding (never below) and records limit_clamped", async () => {
    const { db, store } = coldDb({ limitCents: 10_000_000, outstandingCents: 8_000_000 });
    const res = await reviseLimitsTx(db, { accountId: "acct-1" }, NOW);
    expect(res).toMatchObject({
      changed: true,
      suggestedLimitCents: FLOOR_LIMIT_CENTS, // suggestion was below outstanding
      newLimitCents: 8_000_000, // clamped AT outstanding
      clampedAtOutstanding: true,
      reason: "limit_clamped",
    });
    expect(store.accounts[0].limitCents).toBe(8_000_000);
    expect(store.limitHistory[0].reason).toBe("limit_clamped");
  });

  it("treats an outstanding exactly at the suggestion as unclamped", async () => {
    const { db } = coldDb({ limitCents: 10_000_000, outstandingCents: FLOOR_LIMIT_CENTS });
    const res = await reviseLimitsTx(db, { accountId: "acct-1" }, NOW);
    expect(res).toMatchObject({ newLimitCents: FLOOR_LIMIT_CENTS, clampedAtOutstanding: false, reason: "auto_revision" });
  });
});

describe("reviseLimitsTx — upward + no-op", () => {
  it("applies upward revisions (wave-12 behavior preserved)", async () => {
    const { db, store } = coldDb({ limitCents: 1_000_000, outstandingCents: 0 });
    const res = await reviseLimitsTx(db, { accountId: "acct-1" }, NOW);
    expect(res).toMatchObject({ changed: true, newLimitCents: FLOOR_LIMIT_CENTS, reason: "auto_revision" });
    expect(store.accounts[0].limitCents).toBe(FLOOR_LIMIT_CENTS);
  });

  it("is a no-op (no history row) when the limit is unchanged", async () => {
    const { db, store } = coldDb({ limitCents: FLOOR_LIMIT_CENTS, outstandingCents: 0 });
    const res = await reviseLimitsTx(db, { accountId: "acct-1" }, NOW);
    expect(res).toMatchObject({ changed: false, newLimitCents: FLOOR_LIMIT_CENTS });
    expect(store.limitHistory).toHaveLength(0);
  });

  it("returns null for unknown accounts", async () => {
    const { db } = makeFakeDb();
    expect(await reviseLimitsTx(db, { accountId: "nope" }, NOW)).toBeNull();
  });

  it("revises relative to live scorer input (order volume raises the suggestion)", async () => {
    // Buyer with strong 30d volume + on-time payments ⇒ suggestion above floor.
    const account = seedAccount({ id: "acct-1", limitCents: FLOOR_LIMIT_CENTS });
    const orders = Array.from({ length: 5 }, (_, i) => ({
      tenantId: "buyer-1",
      totalAmount: "200000.00", // ₦200k each → ₦1M 30d volume
      createdAt: new Date(NOW.getTime() - (i + 1) * 24 * 3600 * 1000),
    }));
    const { db, store } = makeFakeDb({ accounts: [account], orders });
    const res = await reviseLimitsTx(db, { accountId: "acct-1" }, NOW);
    expect(res!.changed).toBe(true);
    expect(res!.newLimitCents).toBeGreaterThan(FLOOR_LIMIT_CENTS);
    expect(store.limitHistory[0].oldLimitCents).toBe(FLOOR_LIMIT_CENTS);
    expect(store.limitHistory[0].score).toBeGreaterThan(10);
  });
});
