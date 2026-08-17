/**
 * W14 bureau event emission — consent stamping at request/approve, and the
 * fire-and-forget hooks: draw → disbursement, repayment completion →
 * repayment (+ cure at zero), dunning +3d fee → delinquency(late_fee),
 * dunning +7d freeze → delinquency(freeze), close → closure.
 *
 * BUREAU_PROVIDER is unset in tests ⇒ the 'disabled' adapter: events land in
 * bureau_report_log as 'pending' with their payloads, which is exactly what
 * the assertions inspect (payload shape is the bureau contract).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../waSender", () => ({
  sendWhatsAppText: vi.fn(async () => ({ sent: true, simulated: true, wamid: null, chunks: 1 })),
  sendWhatsAppTemplate: vi.fn(async () => ({ sent: true, simulated: true, wamid: null })),
}));
vi.mock("../sessionWindow", () => ({
  getWindow: vi.fn(async () => ({ open: false, closesAt: null, lastInboundAt: null, source: "none" as const })),
}));

import {
  approveCreditAccountTx,
  bureauConsentRef,
  requestCreditAccountTx,
  setCreditAccountStatusTx,
} from "./accounts";
import { drawOnCreditTx } from "./draw";
import { applyRepaymentTx } from "./repayment";
import { runDunningCheckTx } from "./dunning";
import { makeFakeDb, seedAccount, seedDraw, type TenantRow } from "./fakeDb";
import { BUREAU_CONSENT_TEXT, SUPPORTED_LOCALES } from "../i18n";

const CONSENTED = { bureauConsentAt: new Date("2025-05-01T00:00:00Z"), bureauConsentRef: "bcr:test" };
const buyerTenant: TenantRow = { id: "buyer-1", settings: { adminPhone: "2348011111111" } };

beforeEach(() => {
  delete process.env.BUREAU_PROVIDER;
});

// ── Consent stamping ────────────────────────────────────────────────────────

describe("bureau consent capture", () => {
  it("approveAccount with bureauConsent:true stamps bureauConsentAt + ref", async () => {
    const account = seedAccount({ status: "pending", limitCents: 0 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const row = await approveCreditAccountTx(db, {
      accountId: account.id,
      supplierTenantId: "supplier-1",
      limitCents: 50_000,
      bureauConsent: true,
    });
    expect(row?.status).toBe("active");
    expect(row?.bureauConsentAt).toBeInstanceOf(Date);
    expect(row?.bureauConsentRef).toBe(bureauConsentRef(account.id));
    expect(store.accounts[0].bureauConsentAt).toBeInstanceOf(Date);
  });

  it("approveAccount without bureauConsent leaves consent fields null", async () => {
    const account = seedAccount({ status: "pending", limitCents: 0 });
    const { db } = makeFakeDb({ accounts: [account] });
    const row = await approveCreditAccountTx(db, {
      accountId: account.id,
      supplierTenantId: "supplier-1",
    });
    expect(row?.status).toBe("active");
    expect(row?.bureauConsentAt ?? null).toBeNull();
  });

  it("requestAccount with bureauConsent:true stamps consent at request time", async () => {
    const { db } = makeFakeDb({});
    const row = await requestCreditAccountTx(db, {
      supplierTenantId: "supplier-1",
      buyerTenantId: "buyer-1",
      bureauConsent: true,
    });
    expect(row.status).toBe("pending");
    expect(row.bureauConsentAt).toBeInstanceOf(Date);
    expect(row.bureauConsentRef).toBe(bureauConsentRef(row.id));
  });

  it("requestAccount without bureauConsent stays unconsented", async () => {
    const { db } = makeFakeDb({});
    const row = await requestCreditAccountTx(db, {
      supplierTenantId: "supplier-1",
      buyerTenantId: "buyer-1",
    });
    expect(row.bureauConsentAt ?? null).toBeNull();
  });

  it("consent text exists for every supported locale and names the bureaus", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(BUREAU_CONSENT_TEXT[locale]).toBeTruthy();
      expect(BUREAU_CONSENT_TEXT[locale]).toMatch(/CreditRegistry/);
    }
  });
});

// ── Event emission hooks ────────────────────────────────────────────────────

describe("bureau event emission", () => {
  it("draw success → 'disbursement' with amount/currency/outstanding payload", async () => {
    const account = seedAccount({ ...CONSENTED, createdAt: new Date("2025-01-01T00:00:00Z") });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1",
      buyerTenantId: "buyer-1",
      amountCents: 25_000,
      poId: "po-9",
    }, new Date("2025-06-01T00:00:00Z"));
    expect(res.ok).toBe(true);
    const logs = store.bureauReportLog;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ accountId: account.id, eventType: "disbursement", status: "pending" });
    expect(logs[0].payload).toMatchObject({
      amountCents: 25_000,
      currency: "NGN",
      poId: "po-9",
      outstandingAfter: 25_000,
    });
    expect((logs[0].payload as any).ledgerId).toBeTruthy();
  });

  it("draw on a NON-consented account emits nothing (excluded from reporting)", async () => {
    const account = seedAccount({ createdAt: new Date("2025-01-01T00:00:00Z") });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1",
      buyerTenantId: "buyer-1",
      amountCents: 10_000,
      poId: "po-1",
    }, new Date("2025-06-01T00:00:00Z"));
    expect(res.ok).toBe(true); // money path unaffected
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("failed draw (over limit) emits nothing", async () => {
    const account = seedAccount({ ...CONSENTED, outstandingCents: 95_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1",
      buyerTenantId: "buyer-1",
      amountCents: 10_000,
      poId: "po-2",
      tenureOverride: true,
    });
    expect(res.ok).toBe(false);
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("repayment completion → 'repayment' event with outstandingAfter", async () => {
    const account = seedAccount({ ...CONSENTED, outstandingCents: 30_000 });
    const draw = seedDraw(account.id, { amountCents: 30_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 10_000, ref: "r-1" });
    expect(res).toEqual({ ok: true, outstandingAfter: 20_000 });
    const repays = store.bureauReportLog.filter((l) => l.eventType === "repayment");
    expect(repays).toHaveLength(1);
    expect(repays[0].payload).toMatchObject({ amountCents: 10_000, currency: "NGN", ref: "r-1", outstandingAfter: 20_000 });
    expect(store.bureauReportLog.some((l) => l.eventType === "cure")).toBe(false);
  });

  it("repayment to zero → 'repayment' AND 'cure' events", async () => {
    const account = seedAccount({ ...CONSENTED, outstandingCents: 30_000 });
    const draw = seedDraw(account.id, { amountCents: 30_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 30_000, ref: "r-2" });
    expect(res).toEqual({ ok: true, outstandingAfter: 0 });
    const types = store.bureauReportLog.map((l) => l.eventType);
    expect(types).toEqual(["repayment", "cure"]);
    const cure = store.bureauReportLog.find((l) => l.eventType === "cure");
    expect(cure?.payload).toMatchObject({ outstandingAfter: 0 });
  });

  it("refused repayment (over-payment) emits nothing", async () => {
    const account = seedAccount({ ...CONSENTED, outstandingCents: 5_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 6_000, ref: "r-3" });
    expect(res.ok).toBe(false);
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("dunning +3d late fee → 'delinquency' event with severity late_fee", async () => {
    const account = seedAccount({ ...CONSENTED });
    const draw = seedDraw(account.id, { dueDate: new Date("2025-06-07T00:00:00Z"), amountCents: 50_000 }); // +3d
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw], tenants: [buyerTenant] });
    const res = await runDunningCheckTx(db, new Date("2025-06-10T00:00:00Z"));
    expect(res.feesApplied).toBe(1);
    const delinq = store.bureauReportLog.filter((l) => l.eventType === "delinquency");
    expect(delinq).toHaveLength(1);
    expect(delinq[0].payload).toMatchObject({
      drawId: draw.id,
      amountCents: 50_000,
      daysOverdue: 3,
      severity: "late_fee",
    });
  });

  it("dunning +7d freeze → 'delinquency' event with severity freeze (escalation)", async () => {
    const account = seedAccount({ ...CONSENTED });
    const draw = seedDraw(account.id, { dueDate: new Date("2025-06-01T00:00:00Z"), amountCents: 40_000 }); // +9d
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw], tenants: [buyerTenant] });
    const res = await runDunningCheckTx(db, new Date("2025-06-10T00:00:00Z"));
    expect(res.frozen).toBe(1);
    const severities = store.bureauReportLog
      .filter((l) => l.eventType === "delinquency")
      .map((l) => (l.payload as any).severity);
    // Both milestones fire in one sweep for a draw first seen at +9d:
    // the late fee AND the freeze — severity escalates.
    expect(severities).toContain("freeze");
    expect(severities).toContain("late_fee");
  });

  it("dunning on a non-consented account emits nothing", async () => {
    const account = seedAccount();
    const draw = seedDraw(account.id, { dueDate: new Date("2025-06-01T00:00:00Z") });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw], tenants: [buyerTenant] });
    await runDunningCheckTx(db, new Date("2025-06-10T00:00:00Z"));
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("account close → 'closure' event with the terminal outstanding", async () => {
    const account = seedAccount({ ...CONSENTED, outstandingCents: 12_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const row = await setCreditAccountStatusTx(db, {
      accountId: account.id,
      supplierTenantId: "supplier-1",
      status: "closed",
    });
    expect(row?.status).toBe("closed");
    const closures = store.bureauReportLog.filter((l) => l.eventType === "closure");
    expect(closures).toHaveLength(1);
    expect(closures[0].payload).toMatchObject({ outstandingCents: 12_000, reason: "supplier_close" });
  });

  it("freeze (non-terminal status change) does NOT emit a closure event", async () => {
    const account = seedAccount({ ...CONSENTED });
    const { db, store } = makeFakeDb({ accounts: [account] });
    await setCreditAccountStatusTx(db, {
      accountId: account.id,
      supplierTenantId: "supplier-1",
      status: "frozen",
    });
    expect(store.bureauReportLog).toHaveLength(0);
  });
});
