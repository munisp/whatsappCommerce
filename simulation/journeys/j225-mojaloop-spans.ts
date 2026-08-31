/**
 * === W35 node-python-otel (Coder C) ===
 * J225 — Mojaloop FSPIOP adapter spans + trace header injection.
 *
 * Uses the REAL MojaloopFSPIOPAdapter with a MOCK fetch (globalThis.fetch
 * stubbed + restored):
 *
 *   1. requestQuote → REAL `mojaloop.quote` span (CLIENT kind) with
 *      peer.service=mojaloop, and the outbound fetch carries a W3C
 *      `traceparent` header (W34 injectTraceHeaders reused).
 *   2. executeTransfer → `mojaloop.prepare` span.
 *   3. handleTransferCallback → `mojaloop.fulfil` span with transfer attrs.
 *   4. Fail-open: switch error (!ok) throws to the caller AND records the
 *      span with ERROR status; with telemetry disabled the adapter behaves
 *      exactly as before (no traceparent header added).
 */
import crypto from "crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function makeAdapterConfig() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    switchUrl: "https://switch.example.test",
    fspId: "j225fsp",
    clientCert: "-----BEGIN CERTIFICATE-----\nj225\n-----END CERTIFICATE-----",
    clientKey: "-----BEGIN PRIVATE KEY-----\nj225\n-----END PRIVATE KEY-----",
    caCert: "-----BEGIN CERTIFICATE-----\nj225\n-----END CERTIFICATE-----",
    jwtSigningKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export const journey: Journey = {
  id: "J225",
  name: "mojaloop adapter spans (quote/prepare/fulfil) + traceparent injection, fail-open",
  feature: "W35 node-python-otel: mojaloop FSPIOP adapter spans",
  async run(_world: World) {
    const telemetry = await import("../../server/_core/telemetry");
    const { MojaloopFSPIOPAdapter } = await import("../../services/mojaloop/fspiop_adapter");

    const adapter = new MojaloopFSPIOPAdapter(makeAdapterConfig());
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let nextResponse: { ok: boolean; status: number; body: unknown } = {
      ok: true, status: 200, body: {},
    };
    globalThis.fetch = (async (url: any, init: any) => {
      // Only intercept calls to the mock switch — the booted world may issue
      // its own background fetches, which must pass through untouched.
      if (!String(url).startsWith("https://switch.example.test/")) {
        return realFetch(url, init);
      }
      seen.push({ url: String(url), headers: init?.headers ?? {} });
      return {
        ok: nextResponse.ok,
        status: nextResponse.status,
        json: async () => nextResponse.body,
        text: async () => JSON.stringify(nextResponse.body),
      } as any;
    }) as typeof fetch;

    try {
      // ── 4a. disabled: no traceparent added, call works bare ────────────
      delete process.env.OTEL_ENABLED;
      await telemetry.initTelemetry();
      nextResponse = { ok: true, status: 200, body: { quoteId: "q0" } };
      await adapter.requestQuote({
        quoteId: "q0", transactionId: "t0", payerFspId: "a", payeeFspId: "b",
        payerIdType: "MSISDN", payerIdentifier: "2348000000000",
        payeeIdType: "MSISDN", payeeIdentifier: "2348000000001",
        amount: "10", currency: "NGN", transactionType: "TRANSFER",
      });
      assert(seen.length === 1 && !("traceparent" in seen[0].headers),
        "no traceparent header while telemetry disabled");
      assert(telemetry.getRecordedSpans().every((s) => !s.name.startsWith("mojaloop.")),
        "no mojaloop spans while disabled");

      // ── enable telemetry (in-memory exporter) ──────────────────────────
      process.env.OTEL_ENABLED = "true";
      process.env.OTEL_TRACES_EXPORTER = "inmemory";
      await telemetry.initTelemetry();
      assert(telemetry.isTelemetryActive(), "telemetry did not activate");
      telemetry.clearRecordedSpans();

      // ── 1. quote span + traceparent injection ──────────────────────────
      nextResponse = {
        ok: true, status: 200,
        body: { quoteId: "q1", transferAmount: "10", payeeReceiveAmount: "9.9",
                payeeFspFee: "0.1", payeeFspCommission: "0", expiration: "2030-01-01",
                ilpPacket: "x", condition: "y" },
      };
      await adapter.requestQuote({
        quoteId: "q1", transactionId: "t1", payerFspId: "a", payeeFspId: "b",
        payerIdType: "MSISDN", payerIdentifier: "2348000000000",
        payeeIdType: "MSISDN", payeeIdentifier: "2348000000001",
        amount: "10", currency: "NGN", transactionType: "TRANSFER",
      });
      const quoteCall = seen[seen.length - 1];
      assert(TRACEPARENT_RE.test(String(quoteCall.headers["traceparent"] ?? "")),
        `traceparent injected into FSPIOP headers (got ${quoteCall.headers["traceparent"]})`);
      const quoteSpan = telemetry.getRecordedSpans().find((s) => s.name === "mojaloop.quote");
      assert(quoteSpan, "mojaloop.quote span recorded");
      assert(quoteSpan!.attributes["peer.service"] === "mojaloop", "peer.service=mojaloop");
      assert(String(quoteCall.headers["traceparent"]).includes(quoteSpan!.traceId),
        "injected traceparent carries the quote span's trace");

      // ── 2. prepare span (transfer leg) ─────────────────────────────────
      nextResponse = { ok: true, status: 200, body: { transferId: "tr1", fulfilment: "f", completedTimestamp: "t" } };
      await adapter.executeTransfer({
        transferId: "tr1", payerFspId: "a", payeeFspId: "b", amount: "10",
        currency: "NGN", ilpPacket: "x", condition: "y", expiration: "2030-01-01",
      });
      assert(telemetry.getRecordedSpans().some((s) => s.name === "mojaloop.prepare"),
        "mojaloop.prepare span recorded for POST /transfers");

      // ── 3. fulfil span (callback) ──────────────────────────────────────
      const cb = adapter.handleTransferCallback("tr1", { transferState: "COMMITTED", fulfilment: "f" });
      assert(cb.accepted === true && cb.transferId === "tr1", "callback result unchanged");
      const fulfilSpan = telemetry.getRecordedSpans().find((s) => s.name === "mojaloop.fulfil");
      assert(fulfilSpan, "mojaloop.fulfil span recorded for callback");
      assert(fulfilSpan!.attributes["mojaloop.transfer_id"] === "tr1", "transfer id attribute");

      // ── 4b. fail-open: switch error throws to caller + ERROR span ──────
      nextResponse = { ok: false, status: 500, body: { error: "switch down" } };
      let thrown: Error | null = null;
      try {
        await adapter.requestQuote({
          quoteId: "q2", transactionId: "t2", payerFspId: "a", payeeFspId: "b",
          payerIdType: "MSISDN", payerIdentifier: "2348000000000",
          payeeIdType: "MSISDN", payeeIdentifier: "2348000000001",
          amount: "10", currency: "NGN", transactionType: "TRANSFER",
        });
      } catch (err) {
        thrown = err as Error;
      }
      assert(thrown && thrown.message.includes("Quote request failed: 500"),
        "switch error propagates to the caller");
      const errSpans = telemetry.getRecordedSpans().filter((s) => s.name === "mojaloop.quote");
      assert(errSpans.some((s) => s.statusCode === 2), "failed quote span has ERROR status");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OTEL_ENABLED;
      delete process.env.OTEL_TRACES_EXPORTER;
      const telemetry = await import("../../server/_core/telemetry");
      await telemetry.initTelemetry();
    }
  },
};
