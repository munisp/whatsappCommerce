/**
 * Two ledger-bridge replicas against ONE TigerBeetle and ONE Postgres (docker-compose.realtb-ha.yml).
 *
 * The bridge was a single replica because its safety under several replicas had never been shown: it keeps
 * an in-memory idempotency index and pending map (dev-only; the fallback is off) and relies on Postgres and
 * TigerBeetle for the truth. These prove that holds — the same properties a Kubernetes Service gives you when
 * it load-balances a client's calls across pods — so the bridge can run as 2 replicas (a restart or an OOM
 * is no longer a payments outage). Skipped unless LEDGER_URL_2 is set.
 */
import { describe, it, expect } from "vitest";
import { CFG, postJson, uniqueId } from "./helpers/stack";
import { ledgerAccountId } from "../../server/services/ledgerAccounts";

const A = CFG.ledgerUrl;
const B = process.env.LEDGER_URL_2;
const TB = process.env.TB_ADAPTER_URL;
const suite = B && TB ? describe : describe.skip;

const phone = () => `+234${Math.floor(100000000 + Math.random() * 899999999)}`;
async function acct(id: string) {
  const r = await fetch(`${TB}/api/v1/accounts/${id}`);
  return r.status === 404 ? null : ((await r.json()) as Record<string, number>);
}
const transfer = (base: string, body: Record<string, unknown>) => postJson(base, "/transfer", { ledger: 1, code: 1, ...body });

suite("ledger-bridge x2", () => {
  it("both replicas are on the real ledger with the fallback off", async () => {
    for (const base of [A, B!]) {
      const h = await (await fetch(`${base}/health`)).json();
      expect(h).toMatchObject({ status: "ok", tigerbeetle: { healthy: true }, postgres: { healthy: true } });
    }
  });

  it("the SAME idempotency key sent to both replicas concurrently creates exactly ONE reservation", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("escrow", uniqueId("t"));
    const body = { debit_account_id: debit, credit_account_id: credit, amount: 8000, idempotency_key: uniqueId("race") };
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => transfer(i % 2 ? B! : A, body)));
    expect(rs.every((r) => r.status === 200 || r.status === 201), JSON.stringify(rs.map((r) => r.status))).toBe(true);
    expect(new Set(rs.map((r) => r.body.pending_id)).size).toBe(1);        // one pending id, whichever replica answered
    expect(await acct(debit)).toMatchObject({ debits_pending: 8000 });     // held ONCE, not 20x or 2x
    expect(await acct(credit)).toMatchObject({ credits_pending: 8000 });
  });

  it("reserve on one replica, commit on the OTHER: money moves exactly once, and a retried commit on either is a 200", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("escrow", uniqueId("t"));
    const r = await transfer(A, { debit_account_id: debit, credit_account_id: credit, amount: 1500, idempotency_key: uniqueId("x") });
    const pid = r.body.pending_id;
    expect((await postJson(B!, "/ledger/commit", { pending_id: pid })).status).toBe(200);
    expect((await postJson(A, "/ledger/commit", { pending_id: pid })).status).toBe(200);   // e.g. escrow release after payment.confirm
    expect((await postJson(B!, "/ledger/commit", { pending_id: pid })).status).toBe(200);
    expect(await acct(debit)).toMatchObject({ debits_pending: 0, debits_posted: 1500 });
    expect(await acct(credit)).toMatchObject({ credits_pending: 0, credits_posted: 1500 });
  });

  it("void on one replica, then commit on the other is refused; and a void retried on either is a 200", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("escrow", uniqueId("t"));
    const r = await transfer(B!, { debit_account_id: debit, credit_account_id: credit, amount: 700, idempotency_key: uniqueId("v") });
    expect((await postJson(A, "/ledger/void", { pending_id: r.body.pending_id })).status).toBe(200);
    expect((await postJson(B!, "/ledger/void", { pending_id: r.body.pending_id })).status).toBe(200);
    const c = await postJson(B!, "/ledger/commit", { pending_id: r.body.pending_id });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ error: "ledger_rejected", code: "pending_transfer_already_voided" });
    expect(await acct(debit)).toMatchObject({ debits_pending: 0, debits_posted: 0 });
  });

  it("a transfer committed via one replica can be REVERSED via the other (the journal lives in Postgres, not in memory)", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("merchant-wallet", uniqueId("w"));
    const r = await transfer(A, { debit_account_id: debit, credit_account_id: credit, amount: 2200, single_phase: true, idempotency_key: uniqueId("rev") });
    expect(r.status).toBe(201);
    const rev = await postJson(B!, "/ledger/reverse", { pending_id: r.body.transfer_id, reason: "cross-replica" });
    expect(rev.status).toBe(200);
    expect(await acct(debit)).toMatchObject({ debits_posted: 2200, credits_posted: 2200 });
    const again = await postJson(A, "/ledger/reverse", { pending_id: r.body.transfer_id, reason: "cross-replica" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(await acct(debit)).toMatchObject({ credits_posted: 2200 });     // reversed once
  });

  it("the same single-phase leg sent to both replicas concurrently posts exactly once", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("merchant-wallet", uniqueId("w"));
    const body = { debit_account_id: debit, credit_account_id: credit, amount: 999, single_phase: true, idempotency_key: uniqueId("leg") };
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => transfer(i % 2 ? B! : A, body)));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await acct(debit)).toMatchObject({ debits_posted: 999 });
    expect(await acct(credit)).toMatchObject({ credits_posted: 999 });
  });

  it("many DIFFERENT reservations spread across both replicas all land, and the total is exact", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("escrow", uniqueId("t"));
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      transfer(i % 2 ? B! : A, { debit_account_id: debit, credit_account_id: credit, amount: 10, idempotency_key: uniqueId("m") })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await acct(debit)).toMatchObject({ debits_pending: 300 });
    expect(await acct(credit)).toMatchObject({ credits_pending: 300 });
  });
});
