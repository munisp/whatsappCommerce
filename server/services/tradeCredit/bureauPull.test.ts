/**
 * W18 credit-bureau PULL adapter + approve-flow wiring tests.
 *
 * Adapter tests cover the three providers (disabled / sandbox / http) with
 * an injected FakeHttp — no real network. Wiring tests drive
 * approveCreditAccountTx against the tradeCredit fakeDb and prove:
 * required+consent+clean → approved, required+active-default → declined,
 * required+low-score → declined, required+no-consent → consent_required,
 * adapter failure → approval proceeds, and default (not required) → zero
 * behavior change (no pull, no audit row, no bureauPull metadata).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../waSender", () => ({
  sendWhatsAppText: vi.fn(async () => ({ sent: true, simulated: true, wamid: null, chunks: 1 })),
  sendWhatsAppTemplate: vi.fn(async () => ({ sent: true, simulated: true, wamid: null })),
}));
vi.mock("../sessionWindow", () => ({
  getWindow: vi.fn(async () => ({ open: false, closesAt: null, lastInboundAt: null, source: "none" as const })),
}));

import {
  bureauPullMinScore,
  bureauPullProvider,
  bureauPullRequired,
  bureauReportSchema,
  getBureauPullAdapter,
  pullBureauReport,
  type BureauReport,
} from "./bureauPull";
import {
  approveCreditAccountTx,
  BureauPullDeclinedError,
  bureauConsentRef,
} from "./accounts";
import { makeFakeDb, seedAccount } from "./fakeDb";
import { makeFakeHttp } from "../compliance/fakeHttp";

const SUBJECT = { phone: "2348011111111", bvn: "22223333444", businessName: "Buyer Ltd" };
const CONSENT = "bcr:test-consent";

const CLEAN_REPORT: BureauReport = {
  score: 640,
  totalFacilities: 3,
  activeDefaults: 0,
  delinquentCount: 0,
  enquiryCount90d: 1,
  rawRef: "bureau:clean-1",
};

function httpEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    BUREAU_PULL_PROVIDER: "http",
    BUREAU_PULL_REQUIRED: "true",
    BUREAU_PULL_URL: "https://bureau.example.test/pull",
    BUREAU_PULL_API_KEY: "test-api-key-123",
    ...extra,
  } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  delete process.env.BUREAU_PULL_PROVIDER;
  delete process.env.BUREAU_PULL_REQUIRED;
  delete process.env.BUREAU_PULL_URL;
  delete process.env.BUREAU_PULL_API_KEY;
  delete process.env.BUREAU_PULL_MIN_SCORE;
  delete process.env.BUREAU_PULL_TIMEOUT_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Config ──────────────────────────────────────────────────────────────────

describe("bureau pull config", () => {
  it("defaults: provider disabled, not required, min score 300", () => {
    expect(bureauPullProvider({} as NodeJS.ProcessEnv)).toBe("disabled");
    expect(bureauPullRequired({} as NodeJS.ProcessEnv)).toBe(false);
    expect(bureauPullMinScore({} as NodeJS.ProcessEnv)).toBe(300);
  });

  it("parses sandbox/http providers case-insensitively; unknown → disabled", () => {
    expect(bureauPullProvider({ BUREAU_PULL_PROVIDER: "Sandbox" } as NodeJS.ProcessEnv)).toBe("sandbox");
    expect(bureauPullProvider({ BUREAU_PULL_PROVIDER: "HTTP" } as NodeJS.ProcessEnv)).toBe("http");
    expect(bureauPullProvider({ BUREAU_PULL_PROVIDER: "crc" } as NodeJS.ProcessEnv)).toBe("disabled");
  });

  it("required flag is strict 'true'; min score parses positive ints", () => {
    expect(bureauPullRequired({ BUREAU_PULL_REQUIRED: "TRUE" } as NodeJS.ProcessEnv)).toBe(true);
    expect(bureauPullRequired({ BUREAU_PULL_REQUIRED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(bureauPullMinScore({ BUREAU_PULL_MIN_SCORE: "450" } as NodeJS.ProcessEnv)).toBe(450);
    expect(bureauPullMinScore({ BUREAU_PULL_MIN_SCORE: "-5" } as NodeJS.ProcessEnv)).toBe(300);
    expect(bureauPullMinScore({ BUREAU_PULL_MIN_SCORE: "abc" } as NodeJS.ProcessEnv)).toBe(300);
  });
});

// ── Disabled adapter ────────────────────────────────────────────────────────

describe("disabled provider", () => {
  it("returns a null report and logs the structured 'bureau_pull_disabled' line", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as any);
    const res = await pullBureauReport(SUBJECT, CONSENT, { env: {} as NodeJS.ProcessEnv });
    expect(res.provider).toBe("disabled");
    expect(res.report).toBeNull();
    expect(res.error).toBeUndefined();
    const line = writes.find((w) => w.includes("bureau_pull_disabled"));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line!.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.metric).toBe("bureau_pull_disabled");
  });

  it("getBureauPullAdapter resolves 'disabled' by default", () => {
    expect(getBureauPullAdapter({ env: {} as NodeJS.ProcessEnv }).name).toBe("disabled");
  });
});

// ── Sandbox adapter ─────────────────────────────────────────────────────────

describe("sandbox provider", () => {
  const env = { BUREAU_PULL_PROVIDER: "sandbox" } as NodeJS.ProcessEnv;

  it("produces a deterministic, schema-valid report for the same subject", async () => {
    const a = await pullBureauReport(SUBJECT, CONSENT, { env });
    const b = await pullBureauReport(SUBJECT, CONSENT, { env });
    expect(a.report).not.toBeNull();
    expect(a.report).toEqual(b.report);
    expect(bureauReportSchema.parse(a.report)).toBeTruthy();
    expect(a.report!.rawRef.startsWith("sandbox:")).toBe(true);
    expect(a.report!.score!).toBeGreaterThanOrEqual(200);
    expect(a.report!.score!).toBeLessThanOrEqual(850);
  });

  it("different subjects produce different report refs", async () => {
    const a = await pullBureauReport(SUBJECT, CONSENT, { env });
    const b = await pullBureauReport({ ...SUBJECT, bvn: "99998888777" }, CONSENT, { env });
    expect(a.report!.rawRef).not.toBe(b.report!.rawRef);
  });
});

// ── Http adapter ────────────────────────────────────────────────────────────

describe("http provider", () => {
  it("POSTs the subject + consent ref with bearer auth and parses the report", async () => {
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { status: 200, body: CLEAN_REPORT } },
    });
    const res = await pullBureauReport(SUBJECT, CONSENT, { env: httpEnv(), http });
    expect(res.report).toEqual(CLEAN_REPORT);
    expect(res.error).toBeUndefined();
    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers?.authorization).toBe("Bearer test-api-key-123");
    expect(req.headers?.["content-type"]).toBe("application/json");
    const body = JSON.parse(req.body!);
    expect(body.consent_ref).toBe(CONSENT);
    expect(body.bvn).toBe(SUBJECT.bvn);
    expect(body.business_name).toBe(SUBJECT.businessName);
    expect(req.timeoutMs).toBe(8_000);
  });

  it("timeout → { report: null, error } and never throws", async () => {
    const http = makeFakeHttp({
      latencyMs: 60_000,
      routes: { "https://bureau.example.test/pull": { status: 200, body: CLEAN_REPORT } },
    });
    const res = await pullBureauReport(SUBJECT, CONSENT, {
      env: httpEnv({ BUREAU_PULL_TIMEOUT_MS: "100" }),
      http,
    });
    expect(res.report).toBeNull();
    expect(res.error).toMatch(/timed out/i);
  });

  it("malformed response body → zod rejection, no throw", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://bureau.example.test/pull": {
          status: 200,
          body: { score: "high", activeDefaults: -1 }, // wrong types / missing fields
        },
      },
    });
    const res = await pullBureauReport(SUBJECT, CONSENT, { env: httpEnv(), http });
    expect(res.report).toBeNull();
    expect(res.error).toMatch(/validation/i);
  });

  it("non-2xx response → error result, api key redacted from the message", async () => {
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { status: 503, body: "down" } },
    });
    const res = await pullBureauReport(SUBJECT, CONSENT, { env: httpEnv(), http });
    expect(res.report).toBeNull();
    expect(res.error).toMatch(/HTTP 503/);
    expect(res.error).not.toContain("test-api-key-123");
  });

  it("missing BUREAU_PULL_URL → error result, no throw", async () => {
    const http = makeFakeHttp({ routes: {} });
    const env = httpEnv();
    delete env.BUREAU_PULL_URL;
    const res = await pullBureauReport(SUBJECT, CONSENT, { env, http });
    expect(res.report).toBeNull();
    expect(res.error).toMatch(/BUREAU_PULL_URL/);
    expect(http.requests).toHaveLength(0);
  });

  it("zod schema rejects out-of-range scores and negative counters", () => {
    expect(bureauReportSchema.safeParse(CLEAN_REPORT).success).toBe(true);
    expect(bureauReportSchema.safeParse({ ...CLEAN_REPORT, score: 1200 }).success).toBe(false);
    expect(bureauReportSchema.safeParse({ ...CLEAN_REPORT, activeDefaults: -1 }).success).toBe(false);
    expect(bureauReportSchema.safeParse({ ...CLEAN_REPORT, rawRef: "" }).success).toBe(false);
  });
});

// ── Approval-flow wiring ────────────────────────────────────────────────────

describe("approveCreditAccountTx bureau-pull gate", () => {
  function pendingAccount(consented = true) {
    return seedAccount({
      status: "pending",
      limitCents: 0,
      bureauConsentAt: consented ? new Date("2025-05-01T00:00:00Z") : null,
      bureauConsentRef: consented ? "bcr:test-consent" : null,
    });
  }

  it("required + consent + clean report → approved with bureauPull metadata + audit row", async () => {
    const account = pendingAccount(true);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { status: 200, body: CLEAN_REPORT } },
    });
    const row = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1", limitCents: 50_000 },
      { env: httpEnv(), http },
    );
    expect(row?.status).toBe("active");
    expect(row?.bureauPull).toMatchObject({
      bureauPulled: true,
      provider: "http",
      score: 640,
      activeDefaults: 0,
      rawRef: "bureau:clean-1",
    });
    const audit = store.bureauReportLog.filter((r) => r.eventType === "bureau_pull");
    expect(audit).toHaveLength(1);
    expect(audit[0].status).toBe("sent");
    expect(audit[0].accountId).toBe(account.id);
  });

  it("required + active default → hard decline, account stays pending", async () => {
    const account = pendingAccount(true);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: {
        "https://bureau.example.test/pull": {
          status: 200,
          body: { ...CLEAN_REPORT, activeDefaults: 1 },
        },
      },
    });
    const err = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: httpEnv(), http },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BureauPullDeclinedError);
    expect(err.reason).toBe("bureau_report");
    expect(err.summary).toMatchObject({ bureauPulled: true, activeDefaults: 1 });
    expect(store.accounts[0].status).toBe("pending");
  });

  it("required + score below BUREAU_PULL_MIN_SCORE → hard decline", async () => {
    const account = pendingAccount(true);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: {
        "https://bureau.example.test/pull": {
          status: 200,
          body: { ...CLEAN_REPORT, score: 250 },
        },
      },
    });
    const err = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: httpEnv(), http }, // default min 300 > 250
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BureauPullDeclinedError);
    expect(err.reason).toBe("bureau_report");
    expect(store.accounts[0].status).toBe("pending");
  });

  it("score exactly at the min score is approved (boundary)", async () => {
    const account = pendingAccount(true);
    const { db } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: {
        "https://bureau.example.test/pull": {
          status: 200,
          body: { ...CLEAN_REPORT, score: 450 },
        },
      },
    });
    const row = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: httpEnv({ BUREAU_PULL_MIN_SCORE: "450" }), http },
    );
    expect(row?.status).toBe("active");
  });

  it("required + no consent → decline consent_required, pull never attempted", async () => {
    const account = pendingAccount(false);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { status: 200, body: CLEAN_REPORT } },
    });
    const err = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: httpEnv(), http },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BureauPullDeclinedError);
    expect(err.reason).toBe("consent_required");
    expect(store.accounts[0].status).toBe("pending");
    expect(http.requests).toHaveLength(0);
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("consent granted at approve time (bureauConsent:true) satisfies the gate", async () => {
    const account = pendingAccount(false);
    const { db } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { status: 200, body: CLEAN_REPORT } },
    });
    const row = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1", bureauConsent: true },
      { env: httpEnv(), http },
    );
    expect(row?.status).toBe("active");
    expect(row?.bureauConsentRef).toBe(bureauConsentRef(account.id));
    expect(row?.bureauPull?.bureauPulled).toBe(true);
  });

  it("adapter failure never blocks approval (bureauPulled:false + error summary)", async () => {
    const account = pendingAccount(true);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { error: new Error("connection refused") } },
    });
    const row = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: httpEnv(), http },
    );
    expect(row?.status).toBe("active");
    expect(row?.bureauPull?.bureauPulled).toBe(false);
    expect(row?.bureauPull?.error).toMatch(/connection refused/);
    const audit = store.bureauReportLog.filter((r) => r.eventType === "bureau_pull");
    expect(audit).toHaveLength(1);
    expect(audit[0].status).toBe("failed");
  });

  it("not required (default) → zero behavior change: no pull, no audit, no metadata", async () => {
    const account = pendingAccount(true);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const http = makeFakeHttp({
      routes: { "https://bureau.example.test/pull": { status: 200, body: CLEAN_REPORT } },
    });
    const row = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1", limitCents: 50_000 },
      { env: { BUREAU_PULL_PROVIDER: "http", BUREAU_PULL_URL: "https://bureau.example.test/pull" } as NodeJS.ProcessEnv, http },
    );
    expect(row?.status).toBe("active");
    expect(row?.bureauPull).toBeUndefined();
    expect(http.requests).toHaveLength(0);
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("required but provider 'disabled' → gate skipped entirely", async () => {
    const account = pendingAccount(false);
    const { db, store } = makeFakeDb({ accounts: [account] });
    const row = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: { BUREAU_PULL_REQUIRED: "true", BUREAU_PULL_PROVIDER: "disabled" } as NodeJS.ProcessEnv },
    );
    expect(row?.status).toBe("active");
    expect(row?.bureauPull).toBeUndefined();
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("sandbox provider: deterministic gate on a seeded consented account", async () => {
    const account = pendingAccount(true);
    const { db } = makeFakeDb({ accounts: [account] });
    // Whatever the deterministic report says, the call must not throw and the
    // outcome must be reproducible for an identical account.
    const first = await approveCreditAccountTx(
      db,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: { BUREAU_PULL_PROVIDER: "sandbox", BUREAU_PULL_REQUIRED: "true" } as NodeJS.ProcessEnv },
    ).catch((e) => e);
    const account2 = { ...pendingAccount(true), id: account.id };
    const { db: db2 } = makeFakeDb({ accounts: [account2] });
    const second = await approveCreditAccountTx(
      db2,
      { accountId: account.id, supplierTenantId: "supplier-1" },
      { env: { BUREAU_PULL_PROVIDER: "sandbox", BUREAU_PULL_REQUIRED: "true" } as NodeJS.ProcessEnv },
    ).catch((e) => e);
    const key = (r: any) => (r instanceof BureauPullDeclinedError ? `declined:${r.reason}` : `ok:${r?.bureauPull?.score}`);
    expect(key(first)).toBe(key(second));
  });
});
