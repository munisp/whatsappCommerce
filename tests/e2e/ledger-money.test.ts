/**
 * SERVER-DRIVEN MONEY against a REAL TigerBeetle (scripts/run-e2e.sh --real-tb).
 *
 * The base e2e stack fronts the ledger-bridge with an in-memory TigerBeetle double and runs the bridge
 * with LEDGER_ALLOW_INMEMORY=true, so its money tests could not tell a working ledger from a broken
 * one: every ledger call "succeeded" or silently fell back to memory. These assert on the LEDGER's own
 * balances (read straight from TigerBeetle through the adapter) after the platform has driven real
 * flows — payment.initiate, the signed Paystack webhook — and on the bridge contract the server
 * depends on. Skipped unless TB_ADAPTER_URL points at a real cluster's adapter.
 *
 * Money is in kobo (minor units). Every test uses fresh tenant/customer ids, so account balances
 * start at zero and the suite is re-runnable against a persistent ledger.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { CFG, trpcMutation, mintPlatformSession, seedUser, getSql, closeSql, uniqueId, postRaw, getJson, postJson } from "./helpers/stack";
import { ledgerAccountId } from "../../server/services/ledgerAccounts";

const TB_ADAPTER_URL = process.env.TB_ADAPTER_URL;
const suite = TB_ADAPTER_URL ? describe : describe.skip;

type Acct = { debits_pending: number; debits_posted: number; credits_pending: number; credits_posted: number; ledger: number; code: number } | null;
async function tb(accountId: string): Promise<Acct> {
  const r = await fetch(`${TB_ADAPTER_URL}/api/v1/accounts/${accountId}`);
  return r.status === 404 ? null : ((await r.json()) as Acct);
}
const phone = () => `+234${Math.floor(100000000 + Math.random() * 899999999)}`;
const sign = (raw: string) => createHmac("sha512", CFG.paystackWebhookSecret).update(raw).digest("hex");

async function seedOrder(tenantId: string, orderId: string, total: string, customerId: string) {
  await getSql()`
    INSERT INTO orders (id, "tenantId", "customerId", "orderNumber", status, "totalAmount", currency, "paymentStatus", "createdAt", "updatedAt")
    VALUES (${orderId}, ${tenantId}, ${customerId}, ${`ORD-${orderId.slice(-8).toUpperCase()}`}, 'confirmed', ${total}, 'NGN', 'unpaid', NOW(), NOW())`;
}
async function journal(id: string) {
  const rows = await getSql()<{ status: string }[]>`SELECT status FROM ledger_transfers WHERE id = ${id}`;
  return rows[0]?.status;
}
async function journalByKey(key: string) {
  const rows = await getSql()<{ status: string; amount_minor: string }[]>`SELECT status, amount_minor FROM ledger_transfers WHERE idempotency_key = ${key}`;
  return rows;
}

let adminToken: string;
beforeAll(async () => {
  await seedUser({ openId: "e2e-ledger-admin", name: "E2E Ledger Admin", role: "admin" });
  adminToken = await mintPlatformSession("e2e-ledger-admin", "E2E Ledger Admin");
}, 60_000);
afterAll(async () => { await closeSql(); });

suite("server-driven money on a real ledger", () => {
  it("payment.initiate RESERVES the payment in TigerBeetle; the signed webhook COMMITS it — exactly once", async () => {
    const TENANT = uniqueId("e2e-led-tenant"), ORDER = uniqueId("e2e-led-order"), CUSTOMER = phone();
    const REF = uniqueId("E2E-LED-REF").toUpperCase();
    await seedOrder(TENANT, ORDER, "2500.00", uniqueId("cust"));

    const init = await trpcMutation<{ paymentIntentId: string }>("payment.initiate", {
      tenantId: TENANT, orderId: ORDER, amount: 2500, currency: "NGN", provider: "mojaloop", customerPhone: CUSTOMER,
    }, adminToken);
    expect(init.ok, JSON.stringify(init)).toBe(true);
    if (!init.ok) return;

    const sql = getSql();
    const [intent] = await sql<{ ledgerPendingId: string | null }[]>`SELECT "ledgerPendingId" FROM payment_intents WHERE id = ${init.data.paymentIntentId}`;
    expect(intent.ledgerPendingId, "the payment was never reserved on the ledger").toBeTruthy();

    const customer = ledgerAccountId("customer", CUSTOMER), escrow = ledgerAccountId("escrow", TENANT);
    // Reserved: the money is HELD on both sides, nothing posted, and it is really in TigerBeetle.
    expect(await tb(customer)).toMatchObject({ debits_pending: 250_000, debits_posted: 0 });
    expect(await tb(escrow)).toMatchObject({ credits_pending: 250_000, credits_posted: 0 });
    expect(await journal(intent.ledgerPendingId!)).toBe("pending");

    // Deliver the provider's signed confirmation for this intent.
    await sql`UPDATE payment_intents SET provider = 'paystack', "providerPaymentId" = ${REF} WHERE id = ${init.data.paymentIntentId}`;
    const raw = JSON.stringify({ event: "charge.success", data: { reference: REF, amount: 250_000, currency: "NGN" } });
    const first = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", raw, { "x-paystack-signature": sign(raw) });
    expect(first.body).toMatchObject({ ok: true, action: "confirmed" });

    // Committed: pending cleared, posted moved once, on both sides.
    expect(await tb(customer)).toMatchObject({ debits_pending: 0, debits_posted: 250_000 });
    expect(await tb(escrow)).toMatchObject({ credits_pending: 0, credits_posted: 250_000 });
    expect(await journal(intent.ledgerPendingId!)).toBe("committed");

    // A provider retry of the same webhook must not move money again.
    const replay = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", raw, { "x-paystack-signature": sign(raw) });
    expect(replay.body).toMatchObject({ ok: true, action: "already-completed" });
    expect(await tb(customer)).toMatchObject({ debits_pending: 0, debits_posted: 250_000 });
    expect(await tb(escrow)).toMatchObject({ credits_posted: 250_000 });
  });

  it("a payment the ledger never saw (no reservation) books the INFLOW first, then settles — the escrow can never be overdrawn", async () => {
    const TENANT = uniqueId("e2e-led-leg-tenant"), ORDER = uniqueId("e2e-led-leg-order");
    // customerId is varchar(36); derive it from a short random suffix, not from ORDER (which is already
    // close to that limit on its own — "cust-" + ORDER overflowed it).
    const REF = uniqueId("E2E-LEG-REF").toUpperCase(), CUSTOMER_ID = `cust-${Math.random().toString(36).slice(2, 10)}`, INTENT_ID = randomUUID();
    await seedOrder(TENANT, ORDER, "1200.00", CUSTOMER_ID);
    const sql = getSql();
    await sql`
      INSERT INTO payment_intents (id, "tenantId", "orderId", "customerId", amount, currency, provider, status, "providerPaymentId", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${INTENT_ID}, ${TENANT}, ${ORDER}, ${CUSTOMER_ID}, '1200.00', 'NGN', 'paystack', 'initiated', ${REF}, ${uniqueId("led-intent")}, NOW(), NOW())`;

    const raw = JSON.stringify({ event: "charge.success", data: { reference: REF, amount: 120_000, currency: "NGN" } });
    const first = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", raw, { "x-paystack-signature": sign(raw) });
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ ok: true, action: "confirmed" });

    const customer = ledgerAccountId("customer", CUSTOMER_ID), escrow = ledgerAccountId("escrow", TENANT), merchant = ledgerAccountId("merchant", TENANT);
    // Both legs POSTED (not pending holds that would expire): money in to escrow, then on to the merchant.
    expect(await tb(customer)).toMatchObject({ debits_posted: 120_000, debits_pending: 0 });
    expect(await tb(escrow)).toMatchObject({ credits_posted: 120_000, debits_posted: 120_000, credits_pending: 0, debits_pending: 0 });
    expect(await tb(merchant)).toMatchObject({ credits_posted: 120_000 });
    expect((await journalByKey(`settle-in:${INTENT_ID}`))[0]?.status).toBe("committed");
    expect((await journalByKey(`settle:${INTENT_ID}`))[0]?.status).toBe("committed");

    // Replaying the webhook adds nothing.
    await postRaw(CFG.platformUrl, "/api/webhooks/paystack", raw, { "x-paystack-signature": sign(raw) });
    expect(await tb(escrow)).toMatchObject({ credits_posted: 120_000, debits_posted: 120_000 });

    // And the escrow is now empty: settling ONE more kobo out of it is refused by the LEDGER, as a 409 the caller can act on.
    const over = await postJson(CFG.ledgerUrl, "/transfer", {
      debit_account_id: escrow, credit_account_id: merchant, amount: 1, ledger: 1, code: 2, single_phase: true, idempotency_key: uniqueId("over"),
    });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: "ledger_rejected", code: "exceeds_credits" });
  });
});

suite("the ledger-bridge contract the server depends on, on a real ledger", () => {
  const post = (path: string, body: unknown) => postJson(CFG.ledgerUrl, path, body);

  it("single_phase POSTS immediately (nothing pending, nothing to expire); a replay is a 200; a reversal nets to zero", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("merchant-wallet", uniqueId("w"));
    const key = uniqueId("leg");
    const r = await post("/transfer", { debit_account_id: debit, credit_account_id: credit, amount: 75_000, ledger: 1, code: 1, single_phase: true, idempotency_key: key });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "committed", source: "tigerbeetle" });
    expect(await tb(debit)).toMatchObject({ debits_posted: 75_000, debits_pending: 0 });
    expect(await tb(credit)).toMatchObject({ credits_posted: 75_000, credits_pending: 0 });
    expect((await journalByKey(key))[0]?.status).toBe("committed");

    const replay = await post("/transfer", { debit_account_id: debit, credit_account_id: credit, amount: 75_000, ledger: 1, code: 1, single_phase: true, idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true });
    expect(await tb(debit)).toMatchObject({ debits_posted: 75_000 });        // not debited twice

    const rev = await post("/ledger/reverse", { pending_id: r.body.transfer_id, reason: "e2e" });
    expect(rev.status).toBe(200);
    expect(await tb(debit)).toMatchObject({ debits_posted: 75_000, credits_posted: 75_000 });
    expect(await tb(credit)).toMatchObject({ credits_posted: 75_000, debits_posted: 75_000 });
  });

  it("the old behaviour is gone: a plain /transfer is still a two-phase RESERVE (held, not posted)", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("escrow", uniqueId("t"));
    const r = await post("/transfer", { debit_account_id: debit, credit_account_id: credit, amount: 1000, ledger: 1, code: 1, idempotency_key: uniqueId("res") });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("reserved");
    expect(await tb(debit)).toMatchObject({ debits_pending: 1000, debits_posted: 0 });
    await post("/ledger/void", { pending_id: r.body.pending_id });
  });

  it("opaque account ids are rejected with a 400 (the reason those legs used to vanish), never accepted", async () => {
    const r = await post("/transfer", { debit_account_id: "credit-facility:abc", credit_account_id: "merchant-wallet:xyz", amount: 100, ledger: 1, code: 1, idempotency_key: uniqueId("opaque"), single_phase: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_debit_account");
  });

  it("commit and void are idempotent retries, but contradictory ones are refused as a 409 the caller can act on", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("escrow", uniqueId("t"));
    const reserve = async () => (await post("/transfer", { debit_account_id: debit, credit_account_id: credit, amount: 500, ledger: 1, code: 1, idempotency_key: uniqueId("cv") })).body.pending_id as string;

    const a = await reserve();
    expect((await post("/ledger/commit", { pending_id: a })).status).toBe(200);
    const again = await post("/ledger/commit", { pending_id: a });        // e.g. escrow release after payment.confirm
    expect(again.status).toBe(200);                                       // used to be a 503 on a real ledger
    const voidAfterCommit = await post("/ledger/void", { pending_id: a });
    expect(voidAfterCommit.status).toBe(409);
    expect(voidAfterCommit.body).toMatchObject({ error: "ledger_rejected", code: "pending_transfer_already_posted" });

    const b = await reserve();
    expect((await post("/ledger/void", { pending_id: b })).status).toBe(200);
    expect((await post("/ledger/void", { pending_id: b })).status).toBe(200);
    const commitAfterVoid = await post("/ledger/commit", { pending_id: b });
    expect(commitAfterVoid.status).toBe(409);
    expect(commitAfterVoid.body).toMatchObject({ error: "ledger_rejected", code: "pending_transfer_already_voided" });
  });

  it("GET /balance reports what TigerBeetle holds", async () => {
    const debit = ledgerAccountId("customer", phone()), credit = ledgerAccountId("merchant-wallet", uniqueId("w"));
    await post("/transfer", { debit_account_id: debit, credit_account_id: credit, amount: 4200, ledger: 1, code: 1, single_phase: true, idempotency_key: uniqueId("bal") });
    const b = await getJson(CFG.ledgerUrl, `/balance/${credit}`);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ balance_minor: 4200, reserved_minor: 0, source: "tigerbeetle" });
  });
});
