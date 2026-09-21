/**
 * postDirectLedgerLeg / the ledger legs of pay-over-time and micro-loans (QA-033).
 *
 * These legs used to POST /transfer with opaque ids ("credit-facility:…"), which the bridge rejects
 * with HTTP 400, and then treated 400/409 as "already posted". So they were never recorded. And even
 * with valid ids, /transfer is a two-phase RESERVE, which TigerBeetle voids after 15 minutes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postDirectLedgerLeg, LedgerBridgeError } from "./services/ledgerBridge";
import { ledgerAccountId, LedgerAccountError } from "./services/ledgerAccounts";

type Call = { url: string; method: string; body: any };
let calls: Call[];
let respond: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ status: "committed", replayed: false }), { status: 201 });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return respond(call);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const leg = { debit_ref: "credit-facility:fac-1", credit_ref: "merchant-wallet:wal-9", amount: 250_000, idempotency_key: "loanfund:loan-1" };

describe("postDirectLedgerLeg", () => {
  it("sends UUID ledger ids (never the opaque refs) and asks for a SINGLE-PHASE posting", async () => {
    await postDirectLedgerLeg(leg);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/transfer$/);
    expect(calls[0].body).toEqual({
      debit_account_id: ledgerAccountId("credit-facility", "fac-1"),
      credit_account_id: ledgerAccountId("merchant-wallet", "wal-9"),
      amount: 250_000,
      ledger: 1,
      code: 1,
      idempotency_key: "loanfund:loan-1",
      single_phase: true,
    });
    expect(calls[0].body.debit_account_id).not.toContain("credit-facility");
  });

  it("uses the caller's transfer code when given one", async () => {
    await postDirectLedgerLeg({ ...leg, code: 2 });
    expect(calls[0].body.code).toBe(2);
  });

  it("a replay of the same key is just another 200 — nothing to swallow", async () => {
    respond = () => new Response(JSON.stringify({ status: "committed", replayed: true }), { status: 200 });
    await expect(postDirectLedgerLeg(leg)).resolves.toMatchObject({ replayed: true });
  });

  it.each([
    [400, "a malformed leg (this is what opaque ids used to produce)"],
    [409, "the ledger refusing the leg, e.g. an overdraft"],
    [503, "the ledger being unavailable"],
  ])("THROWS on HTTP %d — %s — instead of treating it as 'already posted'", async (status) => {
    respond = () => new Response(JSON.stringify({ error: "x" }), { status });
    const err = await postDirectLedgerLeg(leg).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerBridgeError);
    expect(err.status).toBe(status);
  });

  it("an unreachable bridge throws too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(postDirectLedgerLeg(leg)).rejects.toBeInstanceOf(LedgerBridgeError);
  });

  it("refuses an unknown account kind BEFORE anything is sent", async () => {
    await expect(postDirectLedgerLeg({ ...leg, debit_ref: "petty-cash:1" })).rejects.toBeInstanceOf(LedgerAccountError);
    expect(calls).toHaveLength(0);
  });
});
