/**
 * FUNDS FLOW — money-movement invariants against the real platform server and
 * the test Postgres. Every assertion here protects a property that must hold
 * even under retries, races, and webhook replays:
 *
 *   (a) escrow.buyerConfirm ×10 concurrent (admin ctx — escrow.ts on main gates
 *       non-admins via assertBuyerOrAdmin) ⇒ EXACTLY ONE wallet credit: one
 *       guarded UPDATE transitions the row, one escrow_release wallet tx, and
 *       the wallet's available_balance moves by net_merchant_amount exactly
 *       once. Plus a FORBIDDEN negative case for a random non-buyer user.
 *   (b) wallet.requestWithdrawal over balance ⇒ rejected; after a full
 *       withdrawal the balance is exactly 0 and any further withdrawal is
 *       rejected. The atomic conditional debit (UPDATE ... WHERE
 *       available_balance >= amount) surfaces INSUFFICIENT_FUNDS and the
 *       balance can never go negative. Same-reference replays return the
 *       existing withdrawal instead of double-debiting.
 *   (c) payment.initiate ×5 concurrent with the same derived idempotency key
 *       (payment:{tenant}:{order}) ⇒ exactly ONE payment_intents row; losers
 *       get CONFLICT (Redis lock held) or an idempotent replay response.
 *   (d) Paystack webhook replay ⇒ first delivery confirms (action
 *       "confirmed"), the second returns "already-completed" and does NOT
 *       double-create the escrow hold or double-credit the wallet.
 *       HMAC note: the global express.json() (server/_core/index.ts) consumes
 *       the body BEFORE the route-level express.raw(), so the server verifies
 *       the signature over JSON.stringify(parsedBody) via toRawBody() — we
 *       therefore sign the EXACT compact JSON string we send (a parse→
 *       stringify round-trip of compact JSON is byte-identical).
 *
 * DB facts (grep-verified against drizzle/schema.ts + server source):
 *   - merchant_wallets: available_balance / total_withdrawn / created_at are
 *     snake_case columns (drizzle/schema.ts merchantWallets).
 *   - wallet_transactions: wallet_id, escrow_tx_id, type, reference.
 *   - escrow_config.platform_fee_rate is numeric(6,4): the seeded "0.03125"
 *     is stored as 0.0313 — the fee is read back from the escrow ROW, never
 *     assumed (server/routers/escrow.ts getEscrowConfig).
 *   - payment_intents uses quoted camelCase columns ("idempotencyKey",
 *     "providerPaymentId") in raw SQL.
 *   - escrow_config is flipped to custody_mode='psp' in beforeAll (wallet
 *     credits + withdrawals only happen in PSP mode) and restored in afterAll.
 *
 * Procedure/route evidence: server/routers/escrow.ts (buyerConfirm,
 * settleEscrowAtomic, walletRouter.requestWithdrawal),
 * server/routers/payment.ts (initiate), server/_core/index.ts:716
 * (/api/webhooks/paystack → confirmProviderPayment).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import {
  CFG,
  trpcMutation,
  trpcQuery,
  mintPlatformSession,
  seedUser,
  getSql,
  closeSql,
  uniqueId,
  postRaw,
} from "./helpers/stack";

let adminToken: string;
let randomToken: string;
let originalCustodyMode: string | null = null;

/** Seed an orders row (escrow_transactions.order_id has an FK to orders.id). */
async function seedOrder(tenantId: string, orderId: string, total: string, customerId: string) {
  const sql = getSql();
  await sql`
    INSERT INTO orders (id, "tenantId", "customerId", "orderNumber", status, "totalAmount", currency, "paymentStatus", "createdAt", "updatedAt")
    VALUES (${orderId}, ${tenantId}, ${customerId}, ${`ORD-${orderId.slice(-8).toUpperCase()}`}, 'confirmed', ${total}, 'NGN', 'unpaid', NOW(), NOW())`;
}

/** Seed a completed payment_intents row so escrow.createHold finds a verified payment. */
async function seedCompletedPaymentIntent(tenantId: string, orderId: string, amount: string, providerRef?: string) {
  const sql = getSql();
  await sql`
    INSERT INTO payment_intents (id, "tenantId", "orderId", "customerId", amount, currency, provider, status, "providerPaymentId", "idempotencyKey", "completedAt", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${tenantId}, ${orderId}, ${`cust-${orderId}`}, ${amount}, 'NGN', 'paystack', 'completed', ${providerRef ?? null}, ${uniqueId("seed-intent")}, NOW(), NOW(), NOW())`;
}

async function getEscrowRow(escrowId: string) {
  const sql = getSql();
  const rows = await sql<
    { id: string; state: string; amount: string; platform_fee: string; net_merchant_amount: string }[]
  >`SELECT id, state, amount, platform_fee, net_merchant_amount FROM escrow_transactions WHERE id = ${escrowId}`;
  return rows[0];
}

async function getWalletByTenant(tenantId: string) {
  const sql = getSql();
  const rows = await sql<{ id: string; available_balance: string; escrow_balance: string; total_withdrawn: string }[]>`
    SELECT id, available_balance, escrow_balance, total_withdrawn FROM merchant_wallets WHERE tenant_id = ${tenantId}`;
  return rows[0];
}

async function countWalletTxs(escrowTxId: string, type: string) {
  const sql = getSql();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_transactions WHERE escrow_tx_id = ${escrowTxId} AND type = ${type}`;
  return rows[0].n;
}

beforeAll(async () => {
  await seedUser({ openId: "e2e-funds-admin", name: "E2E Funds Admin", role: "admin" });
  // A non-admin, non-buyer user (no email/phone matching any customer record).
  await seedUser({ openId: "e2e-funds-random", name: "E2E Random User", role: "user", tenantId: uniqueId("e2e-random-tenant") });
  adminToken = await mintPlatformSession("e2e-funds-admin", "E2E Funds Admin");
  randomToken = await mintPlatformSession("e2e-funds-random", "E2E Random User");

  // Seed the escrow_config row (id=1) via the lazy seeder, then flip custody
  // to PSP so wallet credits and withdrawals are exercised; afterAll restores.
  const cfg = await trpcQuery<{ custodyMode: string }>("escrow.getConfig", undefined, adminToken);
  if (cfg.ok) originalCustodyMode = cfg.data.custodyMode;
  const sql = getSql();
  await sql`UPDATE escrow_config SET custody_mode = 'psp', updated_at = NOW() WHERE id = 1`;
}, 60_000);

afterAll(async () => {
  try {
    const sql = getSql();
    await sql`UPDATE escrow_config SET custody_mode = ${originalCustodyMode ?? "pssp"}, updated_at = NOW() WHERE id = 1`;
  } finally {
    await closeSql();
  }
});

describe("(a) concurrent escrow.buyerConfirm — exactly-once wallet credit", () => {
  const TENANT = uniqueId("e2e-escrow-tenant");
  const ORDER = uniqueId("e2e-order");
  const AMOUNT = "10000.00";
  let escrowId: string;

  it("setup: completed payment → createHold → confirmDelivery (PSP custody)", async () => {
    await seedOrder(TENANT, ORDER, AMOUNT, uniqueId("cust"));
    await seedCompletedPaymentIntent(TENANT, ORDER, AMOUNT);

    const hold = await trpcMutation<{ id: string; state: string; custodyMode: string; platformFee: string; netMerchantAmount: string }>(
      "escrow.createHold",
      { orderId: ORDER, tenantId: TENANT, currency: "NGN", idempotencyKey: uniqueId("hold") },
      adminToken,
    );
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    escrowId = hold.data.id;
    expect(hold.data.state).toBe("escrow_held");
    expect(hold.data.custodyMode).toBe("psp");

    // PSP mode: the hold credits the merchant's ESCROW balance (not available).
    const wallet = await getWalletByTenant(TENANT);
    expect(parseFloat(wallet.escrow_balance)).toBeCloseTo(parseFloat(AMOUNT), 2);
    expect(parseFloat(wallet.available_balance)).toBeCloseTo(0, 2);

    const del = await trpcMutation<{ state: string }>("escrow.confirmDelivery", { escrowId }, adminToken);
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.data.state).toBe("delivery_confirmed");
  });

  it("fee math comes from the escrow row (platform_fee_rate numeric(6,4): 0.03125 → 0.0313)", async () => {
    const sql = getSql();
    const cfg = await sql<{ platform_fee_rate: string }[]>`SELECT platform_fee_rate FROM escrow_config WHERE id = 1`;
    // The seeded "0.03125" is rounded to 4 decimal places by numeric(6,4).
    expect(parseFloat(cfg[0].platform_fee_rate)).toBeCloseTo(0.0313, 4);

    const escrow = await getEscrowRow(escrowId);
    // fee + net == amount; never assume an exact fee value.
    expect(parseFloat(escrow.platform_fee) + parseFloat(escrow.net_merchant_amount))
      .toBeCloseTo(parseFloat(escrow.amount), 2);
    expect(parseFloat(escrow.platform_fee)).toBeGreaterThan(0);
  });

  it("random non-buyer user → FORBIDDEN (assertBuyerOrAdmin)", async () => {
    const r = await trpcMutation("escrow.buyerConfirm", { escrowId }, randomToken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.trpcCode).toBe("FORBIDDEN");
  });

  it("10× concurrent buyerConfirm → exactly ONE transition, ONE escrow_release tx, ONE net credit", async () => {
    const before = await getWalletByTenant(TENANT);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        trpcMutation<{ id: string; state: string }>("escrow.buyerConfirm", { escrowId }, adminToken),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(9);
    for (const l of losers) {
      if (!l.ok) expect(l.error.trpcCode).toBe("CONFLICT");
    }
    if (winners[0].ok) expect(winners[0].data.state).toBe("settled");

    // Invariant 1: exactly one escrow_release wallet transaction for this escrow.
    expect(await countWalletTxs(escrowId, "escrow_release")).toBe(1);
    // The fee portion is deducted exactly once too.
    expect(await countWalletTxs(escrowId, "fee_deduction")).toBe(1);

    // Invariant 2: available_balance moved by net_merchant_amount exactly once.
    const escrow = await getEscrowRow(escrowId);
    const after = await getWalletByTenant(TENANT);
    const delta = parseFloat(after.available_balance) - parseFloat(before.available_balance);
    expect(delta).toBeCloseTo(parseFloat(escrow.net_merchant_amount), 2);

    // Invariant 3: terminal state reached exactly once.
    expect(escrow.state).toBe("settled");
  });
});

describe("(b) wallet.requestWithdrawal — atomic conditional debit, never negative", () => {
  const TENANT = uniqueId("e2e-wd-tenant");

  beforeAll(async () => {
    // Seed a solvent PSP wallet directly (the credit path is covered by (a)).
    const sql = getSql();
    await sql`
      INSERT INTO merchant_wallets (id, tenant_id, currency, available_balance, escrow_balance, total_earned, total_withdrawn, custody_mode, is_active, created_at, updated_at)
      VALUES (${randomUUID()}, ${TENANT}, 'NGN', '1000.00', '0', '1000.00', '0', 'psp', true, NOW(), NOW())`;
  });

  it("withdrawal over balance → INSUFFICIENT_FUNDS, balance untouched", async () => {
    const r = await trpcMutation("wallet.requestWithdrawal", {
      tenantId: TENANT, amount: 1000.01, reference: uniqueId("wd"),
    }, adminToken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.trpcCode).toBe("BAD_REQUEST");
      expect(r.error.message).toContain("INSUFFICIENT_FUNDS");
    }
    const wallet = await getWalletByTenant(TENANT);
    expect(parseFloat(wallet.available_balance)).toBeCloseTo(1000, 2);
  });

  it("full-balance withdrawal succeeds; a SECOND withdrawal is rejected; balance is exactly 0", async () => {
    const ref = uniqueId("wd");
    const first = await trpcMutation<{ success: boolean; status: string; duplicate: boolean }>(
      "wallet.requestWithdrawal",
      { tenantId: TENANT, amount: 1000, reference: ref, bankAccountNumber: "0123456789", bankCode: "044" },
      adminToken,
    );
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.success).toBe(true);
      expect(first.data.status).toBe("pending");
      expect(first.data.duplicate).toBe(false);
    }

    const wallet = await getWalletByTenant(TENANT);
    expect(parseFloat(wallet.available_balance)).toBeCloseTo(0, 2);
    expect(parseFloat(wallet.total_withdrawn)).toBeCloseTo(1000, 2);

    // Second withdrawal over the (now zero) balance → atomic conditional debit
    // rejects it; the balance can never go negative.
    const second = await trpcMutation("wallet.requestWithdrawal", {
      tenantId: TENANT, amount: 1, reference: uniqueId("wd"),
    }, adminToken);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain("INSUFFICIENT_FUNDS");

    // Same-reference replay returns the existing withdrawal (no double debit).
    const replay = await trpcMutation<{ success: boolean; duplicate: boolean }>(
      "wallet.requestWithdrawal", { tenantId: TENANT, amount: 1000, reference: ref }, adminToken,
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.data.duplicate).toBe(true);

    const finalWallet = await getWalletByTenant(TENANT);
    expect(parseFloat(finalWallet.available_balance)).toBeCloseTo(0, 2);
    expect(parseFloat(finalWallet.total_withdrawn)).toBeCloseTo(1000, 2);

    const sql = getSql();
    const txs = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wallet_transactions wt
      JOIN merchant_wallets mw ON mw.id = wt.wallet_id
      WHERE mw.tenant_id = ${TENANT} AND wt.type = 'withdrawal'`;
    expect(txs[0].n).toBe(1);
  });
});

describe("(c) concurrent payment.initiate — idempotency key ⇒ one payment_intents row", () => {
  it("5× same (tenant, order) → exactly one row; losers get CONFLICT or an idempotent replay", async () => {
    const TENANT = uniqueId("e2e-pay-tenant");
    const ORDER = uniqueId("e2e-pay-order");
    const input = {
      tenantId: TENANT,
      orderId: ORDER,
      amount: 2500,
      currency: "NGN",
      provider: "mojaloop", // no external provider keys required
      customerPhone: "+2348012345678",
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        trpcMutation<{ paymentIntentId: string; reference: string; status: string; idempotentReplay?: boolean }>(
          "payment.initiate", input, adminToken,
        ),
      ),
    );

    const oks = results.filter((r) => r.ok);
    const fails = results.filter((r) => !r.ok);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    // Every successful response points at the SAME payment intent (idempotent
    // replay) — there is never a second intent for the same key.
    const intentIds = new Set(oks.map((r) => (r.ok ? r.data.paymentIntentId : "")));
    expect(intentIds.size).toBe(1);
    // Failures are the Redis-lock CONFLICT, never a crash.
    for (const f of fails) {
      if (!f.ok) {
        expect(f.error.trpcCode).toBe("CONFLICT");
        expect(f.error.message).toContain("already in progress");
      }
    }

    // The DB-level invariant: exactly ONE payment_intents row for the derived
    // key payment:{tenant}:{order} (payment_intents uses quoted camelCase
    // columns in raw SQL).
    const sql = getSql();
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM payment_intents WHERE "idempotencyKey" = ${`payment:${TENANT}:${ORDER}`}`;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe([...intentIds][0]);
  });
});

describe("(d) Paystack webhook replay — no double escrow / wallet credit", () => {
  const TENANT = uniqueId("e2e-wh-tenant");
  const ORDER = uniqueId("e2e-wh-order");
  const REF = uniqueId("E2E-PS-REF").toUpperCase();
  const AMOUNT_MAJOR = 5000;
  let escrowId: string;

  it("first delivery confirms; replay returns already-completed; exactly one credit", async () => {
    await seedOrder(TENANT, ORDER, AMOUNT_MAJOR.toFixed(2), uniqueId("cust"));
    // An initiated paystack intent whose providerPaymentId the webhook resolves.
    const sql = getSql();
    await sql`
      INSERT INTO payment_intents (id, "tenantId", "orderId", "customerId", amount, currency, provider, status, "providerPaymentId", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${TENANT}, ${ORDER}, ${`cust-${ORDER}`}, ${AMOUNT_MAJOR.toFixed(2)}, 'NGN', 'paystack', 'initiated', ${REF}, ${uniqueId("wh-intent")}, NOW(), NOW())`;

    // Sign the EXACT compact JSON body sent — the server re-serializes the
    // parsed body (toRawBody) before HMAC-SHA512 verification.
    const raw = JSON.stringify({
      event: "charge.success",
      data: { reference: REF, amount: AMOUNT_MAJOR * 100, currency: "NGN" }, // kobo
    });
    const sig = createHmac("sha512", CFG.paystackWebhookSecret).update(raw).digest("hex");

    const first = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", raw, {
      "x-paystack-signature": sig,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, ok: true, action: "confirmed" });

    // The confirmation drove escrow hold creation + PSP wallet credit.
    const escrows = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM escrow_transactions WHERE order_id = ${ORDER}`;
    expect(escrows.length).toBe(1);
    escrowId = escrows[0].id;
    expect(escrows[0].state).toBe("escrow_held");
    expect(await countWalletTxs(escrowId, "escrow_credit")).toBe(1);
    const wallet = await getWalletByTenant(TENANT);
    expect(parseFloat(wallet.escrow_balance)).toBeCloseTo(AMOUNT_MAJOR, 2);

    // Replay the identical delivery (provider retry): already-completed, and
    // NO second escrow row, NO second wallet credit.
    const second = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", raw, {
      "x-paystack-signature": sig,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ received: true, ok: true, action: "already-completed" });

    const escrowsAfter = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM escrow_transactions WHERE order_id = ${ORDER}`;
    expect(escrowsAfter[0].n).toBe(1);
    expect(await countWalletTxs(escrowId, "escrow_credit")).toBe(1);
    const walletAfter = await getWalletByTenant(TENANT);
    expect(parseFloat(walletAfter.escrow_balance)).toBeCloseTo(AMOUNT_MAJOR, 2);

    const intent = await sql<{ status: string }[]>`
      SELECT status FROM payment_intents WHERE "providerPaymentId" = ${REF}`;
    expect(intent[0].status).toBe("completed");
  });
});
