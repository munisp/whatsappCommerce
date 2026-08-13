/**
 * W13 repayment-at-source capture — charge-first repayment against an active
 * mandate with exactly-once reference claiming and payment-link fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeDb, seedAccount, seedDraw, seedMandate } from "./fakeDb";
import {
  __setDunningNoticeForTests,
  applyMandateRepaymentTx,
  repaymentReference,
} from "./capture";
import { __setMandateProvidersForTests } from "../payments/mandates";

const NOW = new Date("2025-03-10T12:00:00Z");

function mandateProvider(chargeImpl?: () => Promise<any>) {
  return {
    provider: {
      id: "paystack",
      displayName: "Paystack",
      supportsMandates: true,
      initiate: vi.fn(),
      verifyWebhook: vi.fn(),
      fetchStatus: vi.fn(),
      testConnection: vi.fn(),
      createMandate: vi.fn(),
      chargeMandate: vi.fn(chargeImpl ?? (async (ctx: any) => ({
        ok: true, reference: ctx.reference, status: "success" as const, provider: "paystack",
      }))),
      revokeMandate: vi.fn(),
    },
    creds: {},
    config: { priority: 1 },
  };
}

/** Account seeded with an active provider mandate and 10k outstanding. */
function seedWithMandate(over: Record<string, unknown> = {}) {
  const mandate = seedMandate({ id: "m-1", provider: "paystack", status: "active" });
  const account = seedAccount({
    id: "acct-1",
    mandateId: "m-1",
    outstandingCents: 10_000,
    limitCents: 100_000,
    ...over,
  });
  const draw = seedDraw("acct-1", { amountCents: 10_000 });
  const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw], mandates: [mandate] });
  return { db, store, account, mandate };
}

afterEach(() => {
  __setMandateProvidersForTests(null);
  __setDunningNoticeForTests(null);
});

describe("repaymentReference", () => {
  it("matches cr-{accountId}-{yyyymmdd}-{rand}", () => {
    expect(repaymentReference("acct-1", NOW)).toMatch(/^cr-acct-1-20250310-\d{6}$/);
  });
});

describe("applyMandateRepaymentTx — charge-first", () => {
  it("charges the mandate and settles FIFO on success", async () => {
    const { db, store } = seedWithMandate();
    const entry = mandateProvider();
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(res).toMatchObject({ ok: true, mode: "mandate", status: "success", outstandingAfter: 6_000 });
    expect((res as any).reference).toMatch(/^cr-acct-1-20250310-\d{6}$/);
    // Provider received the repayment metadata contract.
    expect(entry.provider.chargeMandate).toHaveBeenCalledWith(
      expect.objectContaining({
        mandateRef: store.mandates[0].mandateRef,
        amountCents: 4_000,
        metadata: { type: "credit_repayment", accountId: "acct-1" },
      }),
      expect.anything(),
    );
    // Ledger: repayment row with the cr- reference.
    const rep = store.ledger.find((l) => l.kind === "repayment");
    expect(rep?.ref).toMatch(/^cr-acct-1-/);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });

  it("settles the draw FIFO and lifts the suspension when outstanding hits 0", async () => {
    const { db, store } = seedWithMandate({ suspended: true, suspensionReason: "dunning_freeze_+7d" });
    __setMandateProvidersForTests(async () => [mandateProvider()] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 10_000 }, NOW);
    expect(res.ok).toBe(true);
    expect(store.accounts[0].outstandingCents).toBe(0);
    expect(store.ledger.find((l) => l.kind === "invoice_draw")?.status).toBe("settled");
    expect(store.accounts[0].suspended).toBe(false);
    expect(store.accounts[0].suspensionReason).toBeNull();
  });

  it("claims the reference exactly-once before charging", async () => {
    const { db, store } = seedWithMandate();
    __setMandateProvidersForTests(async () => [mandateProvider()] as any);
    await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 1_000 }, NOW);
    expect(store.webhookEvents).toHaveLength(1);
    expect(store.webhookEvents[0].type).toBe("credit_repayment");
    expect(store.webhookEvents[0].tenantId).toBe("buyer-1");
    // A replay of the same event id is a duplicate, never a second charge.
    const dup = await import("../webhookDedupe");
    const again = await dup.claimWebhookEvent(db as any, {
      id: store.webhookEvents[0].id,
      tenantId: "buyer-1",
      type: "credit_repayment",
    });
    expect(again).toBe("duplicate");
  });

  it("falls back with a dunning notice when the charge fails (claim released)", async () => {
    const { db, store } = seedWithMandate();
    const entry = mandateProvider(async () => ({
      ok: false, reference: "r", status: "failed" as const, provider: "paystack", error: "insufficient_funds",
    }));
    __setMandateProvidersForTests(async () => [entry] as any);
    const notice = vi.fn(async () => {});
    __setDunningNoticeForTests(notice);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(res).toMatchObject({ ok: false, mode: "fallback", reason: "charge_failed", error: "insufficient_funds" });
    // No money movement, no ledger write, claim released for later retry.
    expect(store.accounts[0].outstandingCents).toBe(10_000);
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(0);
    expect(store.webhookEvents).toHaveLength(0);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({
      buyerTenantId: "buyer-1",
      accountId: "acct-1",
      amountCents: 4_000,
      error: "insufficient_funds",
    }));
  });

  it("falls back when the account has no mandate linked", async () => {
    const account = seedAccount({ id: "acct-1", outstandingCents: 5_000 });
    const { db } = makeFakeDb({ accounts: [account] });
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 1_000 }, NOW);
    expect(res).toMatchObject({ ok: false, mode: "fallback", reason: "no_active_mandate" });
  });

  it("fails closed for unknown accounts and invalid amounts", async () => {
    const { db } = makeFakeDb();
    expect(await applyMandateRepaymentTx(db, { accountId: "nope", amountCents: 1 }, NOW))
      .toMatchObject({ ok: false, reason: "no_account" });
    const { db: db2 } = seedWithMandate();
    expect(await applyMandateRepaymentTx(db2, { accountId: "acct-1", amountCents: 0 }, NOW))
      .toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("never throws when the charge path blows up", async () => {
    const { db } = seedWithMandate();
    __setMandateProvidersForTests(async () => {
      throw new Error("boom");
    });
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 1_000 }, NOW);
    expect(res.ok).toBe(false);
  });

  it("refuses over-repayment at settlement even after a successful charge", async () => {
    const { db, store } = seedWithMandate();
    __setMandateProvidersForTests(async () => [mandateProvider()] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 20_000 }, NOW);
    expect(res).toMatchObject({ ok: false, reason: "settlement_failed" });
    expect(store.accounts[0].outstandingCents).toBe(10_000);
  });
});
