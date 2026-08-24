/**
 * W14 — charge-success/settle-fail hardening.
 *
 * When the mandate charge succeeds but FIFO settlement refuses, money has
 * moved with no settlement. The path must (a) fire a CRITICAL
 * captureException (redacted per observability rules) and (b) persist a
 * durable settlement_retry marker on the credit ledger so the gap survives
 * restarts and can be re-attempted exactly-once via retrySettlement.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { makeFakeDb, seedAccount, seedDraw, seedMandate } from "./fakeDb";

vi.mock("./repayment", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    applyRepaymentTx: vi.fn(async () => ({ ok: false, outstandingAfter: 10_000 })),
  };
});

import { applyMandateRepaymentTx, __setDunningNoticeForTests } from "./capture";
import { __setMandateProvidersForTests } from "../payments/mandates";
import { getRecentErrors, redactExtra, _resetRecentErrors } from "../observability";

const NOW = new Date("2025-03-10T12:00:00Z");

function mandateProvider() {
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
      chargeMandate: vi.fn(async (ctx: any) => ({
        ok: true, reference: ctx.reference, status: "success" as const, provider: "paystack",
      })),
      revokeMandate: vi.fn(),
    },
    creds: {},
    config: { priority: 1 },
  };
}

function seedWithMandate() {
  const mandate = seedMandate({ id: "m-1", provider: "paystack", status: "active" });
  const account = seedAccount({
    id: "acct-1",
    mandateId: "m-1",
    outstandingCents: 10_000,
    limitCents: 100_000,
  });
  const draw = seedDraw("acct-1", { amountCents: 10_000 });
  const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw], mandates: [mandate] });
  return { db, store };
}

beforeEach(() => _resetRecentErrors());
afterEach(() => {
  __setMandateProvidersForTests(null);
  __setDunningNoticeForTests(null);
  _resetRecentErrors();
});

describe("charge-success / settle-fail (W14)", () => {
  it("fires a CRITICAL capture with reference/accountId/amount, redacted per observability rules", async () => {
    const { db } = seedWithMandate();
    __setMandateProvidersForTests(async () => [mandateProvider()] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(res).toMatchObject({ ok: false, mode: "none", reason: "settlement_failed" });
    const reference = (res as any).reference as string;
    expect(reference).toMatch(/^cr-acct-1-20250310-[0-9a-f]{12}$/);

    const errors = getRecentErrors(10);
    expect(errors).toHaveLength(1);
    const entry = errors[0];
    expect(entry.severity).toBe("critical");
    expect(entry.service).toBe("tradeCredit/capture");
    expect(entry.operation).toBe("mandateRepaymentSettlement");
    expect(entry.tenantId).toBe("buyer-1");
    expect(entry.message).toContain(reference);
    expect(entry.extra).toMatchObject({
      accountId: "acct-1",
      reference,
      amountCents: 4_000,
      provider: "paystack",
      providerStatus: "success",
    });
    // The capture pipeline redacts sensitive keys on this payload shape.
    expect(JSON.stringify(entry.extra)).not.toMatch(/secret|token|password/i);
    expect(redactExtra({ ...entry.extra, accessToken: "super-secret" })?.accessToken).toBe("[redacted]");
  });

  it("persists a durable settlement_retry marker (zero-amount adjustment, ref + amount in note)", async () => {
    const { db, store } = seedWithMandate();
    __setMandateProvidersForTests(async () => [mandateProvider()] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    const reference = (res as any).reference as string;

    const marker = store.ledger.find((l) => l.kind === "adjustment" && l.ref === reference);
    expect(marker).toBeDefined();
    expect(marker!.amountCents).toBe(0); // never distorts the FIFO pool
    expect(marker!.note).toMatch(/^\[settlement_retry\] /);
    expect(JSON.parse(marker!.note!.slice("[settlement_retry] ".length))).toEqual({ amountCents: 4_000 });
    // The exactly-once charge claim is KEPT (the charge is never retried).
    expect(store.webhookEvents).toHaveLength(1);
    // No repayment row and no outstanding decrement (settlement refused).
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(0);
    expect(store.accounts[0].outstandingCents).toBe(10_000);
  });

  it("does NOT send a dunning notice on settle-fail (the charge succeeded)", async () => {
    const { db } = seedWithMandate();
    __setMandateProvidersForTests(async () => [mandateProvider()] as any);
    const notice = vi.fn(async () => {});
    __setDunningNoticeForTests(notice);
    await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(notice).not.toHaveBeenCalled();
  });
});
