/**
 * W14 credit-bureau reporting — adapters (crc/creditregistry/customHttp/
 * disabled), timeout, redaction, consent gating, retry semantics, disputes.
 *
 * All network via makeFakeHttp; all persistence via the tradeCredit fakeDb
 * (extended with bureau_report_log). No real I/O.
 */
import { describe, it, expect } from "vitest";
import {
  getBureauAdapter,
  bureauProvider,
  bureauTimeoutMs,
  redactPayload,
  reportEvent,
  retryFailedReports,
  markDisputed,
} from "../bureau";
import { makeFakeHttp, HttpTimeoutError } from "../fakeHttp";
import { makeFakeDb, seedAccount, type BureauLogRow } from "../../tradeCredit/fakeDb";

const ENV_CRC = {
  BUREAU_PROVIDER: "crc",
  BUREAU_API_BASE: "https://crc.example.test",
  BUREAU_API_KEY: "sekret-key-123",
} as NodeJS.ProcessEnv;

function consentedSeed() {
  const account = seedAccount({ bureauConsentAt: new Date("2025-05-01T00:00:00Z"), bureauConsentRef: "bcr:test" });
  return { account, ...makeFakeDb({ accounts: [account] }) };
}

function logRow(accountId: string, over: Partial<BureauLogRow> = {}): BureauLogRow {
  return {
    id: over.id ?? `log-${Math.random().toString(36).slice(2, 10)}`,
    accountId,
    eventType: over.eventType ?? "disbursement",
    bureau: over.bureau ?? "crc",
    status: over.status ?? "pending",
    payload: over.payload ?? { amountCents: 1000 },
    response: over.response ?? null,
    createdAt: new Date("2025-05-02T00:00:00Z"),
    updatedAt: new Date("2025-05-02T00:00:00Z"),
    ...over,
  };
}

// ── Provider resolution ─────────────────────────────────────────────────────

describe("bureauProvider / config", () => {
  it("defaults to 'disabled' when BUREAU_PROVIDER is unset", () => {
    expect(bureauProvider({} as NodeJS.ProcessEnv)).toBe("disabled");
    expect(getBureauAdapter({ env: {} as NodeJS.ProcessEnv }).name).toBe("disabled");
  });

  it("unknown provider strings fall back to 'disabled' (fail-safe)", () => {
    expect(bureauProvider({ BUREAU_PROVIDER: "experian" } as NodeJS.ProcessEnv)).toBe("disabled");
  });

  it("parses crc / creditregistry / customHttp (case-insensitive)", () => {
    expect(bureauProvider({ BUREAU_PROVIDER: "CRC" } as NodeJS.ProcessEnv)).toBe("crc");
    expect(bureauProvider({ BUREAU_PROVIDER: "creditregistry" } as NodeJS.ProcessEnv)).toBe("creditregistry");
    expect(bureauProvider({ BUREAU_PROVIDER: "customHttp" } as NodeJS.ProcessEnv)).toBe("customHttp");
  });

  it("bureauTimeoutMs defaults to 8000 and honors a positive override", () => {
    expect(bureauTimeoutMs({} as NodeJS.ProcessEnv)).toBe(8000);
    expect(bureauTimeoutMs({ BUREAU_TIMEOUT_MS: "2500" } as NodeJS.ProcessEnv)).toBe(2500);
    expect(bureauTimeoutMs({ BUREAU_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv)).toBe(8000);
  });
});

// ── Adapters ────────────────────────────────────────────────────────────────

describe("bureau adapters", () => {
  const event = { accountId: "acc-1", eventType: "disbursement" as const, payload: { amountCents: 5000 } };

  it("crc: POSTs to {base}/v1/reports with bearer auth and the event body", async () => {
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 200, body: { ref: "crc-1" } } } });
    const adapter = getBureauAdapter({ env: ENV_CRC, http });
    const res = await adapter.send(event);
    expect(res).toEqual({ ref: "crc-1" });
    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req.url).toBe("https://crc.example.test/v1/reports");
    expect(req.method).toBe("POST");
    expect(req.headers?.authorization).toBe("Bearer sekret-key-123");
    const body = JSON.parse(req.body!);
    expect(body.bureau_event).toBe("disbursement");
    expect(body.account_ref).toBe("acc-1");
    expect(body.amountCents).toBe(5000);
  });

  it("creditregistry: POSTs to {base}/api/reports with x-api-key auth", async () => {
    const http = makeFakeHttp({ routes: { "https://cr.example.test": { status: 201, body: { ok: true } } } });
    const adapter = getBureauAdapter({
      env: { BUREAU_PROVIDER: "creditregistry", BUREAU_API_BASE: "https://cr.example.test/", BUREAU_API_KEY: "k" } as NodeJS.ProcessEnv,
      http,
    });
    await adapter.send(event);
    expect(http.requests[0].url).toBe("https://cr.example.test/api/reports"); // trailing slash stripped
    expect(http.requests[0].headers?.["x-api-key"]).toBe("k");
  });

  it("customHttp: POSTs declaratively to BUREAU_API_BASE as the full endpoint", async () => {
    const http = makeFakeHttp({ routes: { "https://bureau.internal/report": { status: 200, body: {} } } });
    const adapter = getBureauAdapter({
      env: { BUREAU_PROVIDER: "customHttp", BUREAU_API_BASE: "https://bureau.internal/report", BUREAU_API_KEY: "zz" } as NodeJS.ProcessEnv,
      http,
    });
    await adapter.send(event);
    expect(http.requests[0].url).toBe("https://bureau.internal/report");
    expect(http.requests[0].headers?.authorization).toBe("Bearer zz");
  });

  it("disabled adapter send() is an inert no-op", async () => {
    const adapter = getBureauAdapter({ env: {} as NodeJS.ProcessEnv });
    await expect(adapter.send(event)).resolves.toBeNull();
  });

  it("throws when BUREAU_API_BASE is missing (misconfiguration surfaces)", async () => {
    const http = makeFakeHttp({ routes: {} });
    const adapter = getBureauAdapter({ env: { BUREAU_PROVIDER: "crc" } as NodeJS.ProcessEnv, http });
    await expect(adapter.send(event)).rejects.toThrow(/BUREAU_API_BASE/);
    expect(http.requests).toHaveLength(0);
  });

  it("non-2xx upstream response rejects with the HTTP status", async () => {
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 503, body: "down" } } });
    const adapter = getBureauAdapter({ env: ENV_CRC, http });
    await expect(adapter.send(event)).rejects.toThrow(/503/);
  });

  it("client timeout aborts the send (8s default via fakeHttp latency)", async () => {
    const http = makeFakeHttp({ latencyMs: 10_000, routes: { "https://crc.example.test": { status: 200, body: {} } } });
    const adapter = getBureauAdapter({ env: ENV_CRC, http });
    await expect(adapter.send(event)).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("BUREAU_TIMEOUT_MS override is honored (fast upstream under a tight budget succeeds)", async () => {
    const http = makeFakeHttp({ latencyMs: 20, routes: { "https://crc.example.test": { status: 200, body: { ok: 1 } } } });
    const adapter = getBureauAdapter({ env: { ...ENV_CRC, BUREAU_TIMEOUT_MS: "500" } as NodeJS.ProcessEnv, http });
    await expect(adapter.send(event)).resolves.toEqual({ ok: 1 });
    expect(http.requests[0].timeoutMs).toBe(500);
  });
});

// ── Redaction ───────────────────────────────────────────────────────────────

describe("redaction", () => {
  it("redactPayload strips secret-ish keys (nested) and keeps the rest", () => {
    const out = redactPayload({
      amountCents: 100,
      apiKey: "abc123",
      nested: { password: "pw", authorization: "Bearer x", note: "ok" },
    }) as any;
    expect(out.amountCents).toBe(100);
    expect(out.apiKey).toBe("[redacted]");
    expect(out.nested.password).toBe("[redacted]");
    expect(out.nested.authorization).toBe("[redacted]");
    expect(out.nested.note).toBe("ok");
  });

  it("the API key never appears in stored failure responses", async () => {
    const { account, db, store } = consentedSeed();
    const http = makeFakeHttp({
      routes: { "https://crc.example.test": { error: new Error("upstream rejected key sekret-key-123") } },
    });
    const res = await reportEvent(db, { accountId: account.id, eventType: "repayment", payload: {} }, { env: ENV_CRC, http });
    expect(res.reported).toBe(false);
    const stored = store.bureauReportLog[0];
    expect(stored.status).toBe("failed");
    expect(JSON.stringify(stored.response)).not.toContain("sekret-key-123");
    expect(JSON.stringify(stored.response)).toContain("[REDACTED]");
  });

  it("secret-ish payload keys are redacted before the outbound send", async () => {
    const { account, db } = consentedSeed();
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 200, body: {} } } });
    await reportEvent(
      db,
      { accountId: account.id, eventType: "cure", payload: { token: "leak", amountCents: 1 } },
      { env: ENV_CRC, http },
    );
    const body = JSON.parse(http.requests[0].body!);
    expect(body.token).toBe("[redacted]");
    expect(body.amountCents).toBe(1);
  });

  // W14.1 — success-path response redaction (previously persisted raw).
  it("secret-ish keys in the SUCCESS response are redacted before persist; provenance intact", async () => {
    const { account, db, store } = consentedSeed();
    const http = makeFakeHttp({
      routes: {
        "https://crc.example.test": {
          status: 200,
          body: { ack: "a1", ref: "crc-99", sessionToken: "abc123", nested: { password: "pw", note: "ok" } },
        },
      },
    });
    const res = await reportEvent(
      db,
      { accountId: account.id, eventType: "repayment", payload: { amountCents: 5 } },
      { env: ENV_CRC, http },
    );
    expect(res).toMatchObject({ reported: true, status: "sent" });
    const row = store.bureauReportLog[0];
    expect(row.status).toBe("sent");
    expect(row.response).toEqual({ ack: "a1", ref: "crc-99", sessionToken: "[redacted]", nested: { password: "[redacted]", note: "ok" } });
  });

  it("an api-key value echoed in the SUCCESS response body is redacted before persist", async () => {
    const { account, db, store } = consentedSeed();
    const http = makeFakeHttp({
      routes: { "https://crc.example.test": { status: 200, body: { ack: "a1", echo: "key=sekret-key-123 ok" } } },
    });
    await reportEvent(
      db,
      { accountId: account.id, eventType: "repayment", payload: { amountCents: 5 } },
      { env: ENV_CRC, http },
    );
    const stored = JSON.stringify(store.bureauReportLog[0].response);
    expect(stored).not.toContain("sekret-key-123");
    expect(stored).toContain("[REDACTED]");
    expect(stored).toContain("a1"); // provenance intact
  });
});

// ── reportEvent ─────────────────────────────────────────────────────────────

describe("reportEvent", () => {
  it("unknown account → reported:false, reason account_not_found, no log row", async () => {
    const { db, store } = makeFakeDb({});
    const res = await reportEvent(db, { accountId: "nope", eventType: "closure", payload: {} });
    expect(res).toEqual({ reported: false, reason: "account_not_found" });
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("EXCLUDES non-consented accounts: skip with reason consent_missing, no log row", async () => {
    const account = seedAccount(); // no bureauConsentAt
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await reportEvent(db, { accountId: account.id, eventType: "disbursement", payload: { amountCents: 5 } }, { env: ENV_CRC });
    expect(res.reported).toBe(false);
    expect(res.reason).toBe("consent_missing");
    expect(store.bureauReportLog).toHaveLength(0);
  });

  it("disabled provider: persists a 'pending' log row for later backfill, no network", async () => {
    const { account, db, store } = consentedSeed();
    const http = makeFakeHttp({ routes: {} });
    const res = await reportEvent(
      db,
      { accountId: account.id, eventType: "disbursement", payload: { amountCents: 7000 } },
      { env: {} as NodeJS.ProcessEnv, http },
    );
    expect(res).toMatchObject({ reported: false, reason: "provider_disabled", status: "pending" });
    expect(http.requests).toHaveLength(0);
    expect(store.bureauReportLog).toHaveLength(1);
    expect(store.bureauReportLog[0]).toMatchObject({
      accountId: account.id, eventType: "disbursement", bureau: "disabled", status: "pending",
    });
  });

  it("success path: pending → sent with the upstream response stored", async () => {
    const { account, db, store } = consentedSeed();
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 200, body: { ack: "a1" } } } });
    const res = await reportEvent(
      db,
      { accountId: account.id, eventType: "delinquency", payload: { daysOverdue: 3, severity: "late_fee" } },
      { env: ENV_CRC, http },
    );
    expect(res).toMatchObject({ reported: true, status: "sent" });
    const row = store.bureauReportLog[0];
    expect(row.status).toBe("sent");
    expect(row.bureau).toBe("crc");
    expect(row.response).toEqual({ ack: "a1" });
    expect(row.payload).toMatchObject({ daysOverdue: 3, severity: "late_fee" });
  });

  it("send failure: row flips to 'failed' (retryable), error recorded, never throws", async () => {
    const { account, db, store } = consentedSeed();
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 500, body: "err" } } });
    const res = await reportEvent(
      db,
      { accountId: account.id, eventType: "repayment", payload: { amountCents: 1 } },
      { env: ENV_CRC, http },
    );
    expect(res).toMatchObject({ reported: false, reason: "send_failed", status: "failed" });
    expect(store.bureauReportLog[0].status).toBe("failed");
    expect(JSON.stringify(store.bureauReportLog[0].response)).toContain("500");
  });

  it("never throws even when the db itself fails", async () => {
    const brokenDb = {
      select: () => { throw new Error("db down"); },
      insert: () => { throw new Error("db down"); },
      update: () => { throw new Error("db down"); },
    };
    const res = await reportEvent(brokenDb as any, { accountId: "x", eventType: "closure", payload: {} }, { env: ENV_CRC });
    expect(res.reported).toBe(false);
  });
});

// ── retryFailedReports ──────────────────────────────────────────────────────

describe("retryFailedReports", () => {
  it("is a no-op when the provider is disabled", async () => {
    const account = seedAccount({ bureauConsentAt: new Date() });
    const row = logRow(account.id);
    const { db } = makeFakeDb({ accounts: [account], bureauReportLog: [row] });
    const out = await retryFailedReports(db, { env: {} as NodeJS.ProcessEnv });
    expect(out).toEqual({ attempted: 0, sent: 0, failed: 0 });
  });

  it("retries pending AND failed rows; success flips them to sent", async () => {
    const account = seedAccount({ bureauConsentAt: new Date() });
    const rows = [logRow(account.id, { status: "pending" }), logRow(account.id, { status: "failed" })];
    const { db, store } = makeFakeDb({ accounts: [account], bureauReportLog: rows });
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 200, body: { ok: true } } } });
    const out = await retryFailedReports(db, { env: ENV_CRC, http });
    expect(out).toEqual({ attempted: 2, sent: 2, failed: 0 });
    expect(store.bureauReportLog.every((r) => r.status === "sent")).toBe(true);
    expect(http.requests).toHaveLength(2);
  });

  it("keeps rows 'failed' when the upstream is still down", async () => {
    const account = seedAccount({ bureauConsentAt: new Date() });
    const { db, store } = makeFakeDb({ accounts: [account], bureauReportLog: [logRow(account.id)] });
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 502, body: "bad gw" } } });
    const out = await retryFailedReports(db, { env: ENV_CRC, http });
    expect(out).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expect(store.bureauReportLog[0].status).toBe("failed");
  });

  it("skips disputed rows and accounts without consent", async () => {
    const consented = seedAccount({ id: "acc-c", bureauConsentAt: new Date() });
    const other = seedAccount({ id: "acc-n" }); // not consented
    const rows = [
      logRow(consented.id, { status: "disputed" }),
      logRow(other.id, { status: "pending" }),
    ];
    const { db } = makeFakeDb({ accounts: [consented, other], bureauReportLog: rows });
    const http = makeFakeHttp({ routes: { "https://crc.example.test": { status: 200, body: {} } } });
    const out = await retryFailedReports(db, { env: ENV_CRC, http });
    expect(out.attempted).toBe(1); // only the pending row is attempted...
    expect(out.sent).toBe(0);      // ...but skipped for missing consent
    expect(http.requests).toHaveLength(0);
  });
});

// ── markDisputed ────────────────────────────────────────────────────────────

describe("markDisputed", () => {
  it("flips a logged report to 'disputed' and returns the row", async () => {
    const row = logRow("acc-1", { status: "sent" });
    const { db, store } = makeFakeDb({ bureauReportLog: [row] });
    const updated = await markDisputed(db, row.id);
    expect(updated?.status).toBe("disputed");
    expect(store.bureauReportLog[0].status).toBe("disputed");
  });

  it("returns null for an unknown log id", async () => {
    const { db } = makeFakeDb({});
    await expect(markDisputed(db, "missing")).resolves.toBeNull();
  });
});
