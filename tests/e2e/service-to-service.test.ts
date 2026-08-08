/**
 * SERVICE-TO-SERVICE — cross-service hops that the platform-only suites can't
 * see. Each live assertion is gated: when the target service is not part of
 * the running stack (e.g. `run-e2e.sh --no-ml`, or a local partial stack) the
 * test SKIPS via reachability/configuration probes (helpers/stack.ts
 * reachable()/serviceConfigured()) instead of failing.
 *
 * Hops covered (all grep-verified against source):
 *   platform → ml-inference   POST /predict — fraud score + source field
 *                             (services/ml-stack/inference/server.py:385;
 *                             live only when ML_URL / ML_STACK_URL is set)
 *   test → ledger-bridge      reserve → commit → void balance deltas through
 *                             the tb-sidecar fixture (rust/ledger-bridge
 *                             routes /transfer, /ledger/commit, /ledger/void,
 *                             /balance/:id — main.rs:1396-1404)
 *   test → recon-worker       POST /recon/trigger + GET /recon/last
 *                             (rust/recon-worker/src/main.rs:470-471)
 *   test → api-gateway        /api/v1/* proxying mode detection:
 *                             404 = legacy-HS256 mode, proxied but the
 *                             ForwardTo handler preserves the FULL request URI
 *                             (services/gateway/internal/proxy/proxy.go:32-36)
 *                             while commerce-engine mounts /products
 *                             (services/commerce-engine/cmd/main.go:38) —
 *                             a pinned path-mismatch; 401 = Keycloak mode
 *                             (our minted HS256 token is rejected). Either
 *                             way the gateway must never 502 (upstream is up).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CFG,
  getJson,
  postJson,
  mintGatewayJwt,
  reachable,
  serviceConfigured,
  uniqueId,
} from "./helpers/stack";

describe("platform → ml-inference", () => {
  // run-e2e.sh exports ML_URL only with `--profile ml`; a local platform boot
  // sets ML_STACK_URL instead. Either one means "ML is supposed to be live".
  const ML_BASE = process.env.ML_URL ?? process.env.ML_STACK_URL ?? CFG.mlUrl;

  it("POST /predict returns a fraud probability + source field", async (ctx) => {
    if (!serviceConfigured("ML_URL") && !serviceConfigured("ML_STACK_URL")) {
      ctx.skip(); // stack started with --no-ml / no ML configured
    }
    if (!(await reachable(ML_BASE, "/health"))) ctx.skip();

    const { status, body } = await postJson(ML_BASE, "/predict", {
      amount: 1500,
      num_items: 2,
      tenant_id: "e2e-tenant",
      order_id: uniqueId("e2e-ml-order"),
    });
    expect(status).toBe(200);
    expect(typeof body.fraud_probability).toBe("number");
    expect(body.fraud_probability).toBeGreaterThanOrEqual(0);
    expect(body.fraud_probability).toBeLessThanOrEqual(1);
    expect(typeof body.risk_level).toBe("string");
    // `source` reports which model produced the score (model or heuristic fallback).
    expect(typeof body.source).toBe("string");
    expect(body.source.length).toBeGreaterThan(0);
    expect(typeof body.credit_score).toBe("number");
  });
});

describe("ledger-bridge (TigerBeetle 2-phase via tb-sidecar fixture)", () => {
  async function balanceOf(accountId: string) {
    const { status, body } = await getJson(CFG.ledgerUrl, `/balance/${accountId}`);
    expect(status).toBe(200);
    return body as { balance_minor: number; reserved_minor: number; available_minor: number };
  }

  it("reserve → commit moves pending → posted (balance deltas in minor units)", async (ctx) => {
    if (!(await reachable(CFG.ledgerUrl, "/health"))) ctx.skip();

    const debit = randomUUID();
    const credit = randomUUID();
    const amountMinor = 250_000; // ₦2,500.00 in kobo

    const reserve = await postJson(CFG.ledgerUrl, "/transfer", {
      debit_account_id: debit,
      credit_account_id: credit,
      amount: amountMinor,
      ledger: 1,
      code: 1,
      idempotency_key: uniqueId("e2e-ledger-commit"),
    });
    expect(reserve.status).toBe(201);
    expect(reserve.body.status).toBe("reserved");
    const pendingId = reserve.body.pending_id as string;
    expect(typeof pendingId).toBe("string");

    // After reserve: funds sit in the PENDING buckets only.
    const mid = await balanceOf(debit);
    expect(mid.reserved_minor).toBe(amountMinor);
    expect(mid.balance_minor).toBe(0);

    const commit = await postJson(CFG.ledgerUrl, "/ledger/commit", { pending_id: pendingId });
    expect(commit.status).toBe(200);
    expect(commit.body.status).toBe("committed");

    // After commit: pending cleared; posted debits/credits moved exactly once.
    const afterDebit = await balanceOf(debit);
    expect(afterDebit.reserved_minor).toBe(0);
    expect(afterDebit.balance_minor).toBe(-amountMinor); // debits_posted on the debit side
    const afterCredit = await balanceOf(credit);
    expect(afterCredit.balance_minor).toBe(amountMinor); // credits_posted on the credit side
  });

  it("reserve → void releases the reservation (balances return to baseline)", async (ctx) => {
    if (!(await reachable(CFG.ledgerUrl, "/health"))) ctx.skip();

    const debit = randomUUID();
    const credit = randomUUID();
    const amountMinor = 100_000; // ₦1,000.00

    const reserve = await postJson(CFG.ledgerUrl, "/transfer", {
      debit_account_id: debit,
      credit_account_id: credit,
      amount: amountMinor,
      ledger: 1,
      code: 1,
      idempotency_key: uniqueId("e2e-ledger-void"),
    });
    expect(reserve.status).toBe(201);
    const pendingId = reserve.body.pending_id as string;

    const mid = await balanceOf(debit);
    expect(mid.reserved_minor).toBe(amountMinor);

    const voidRes = await postJson(CFG.ledgerUrl, "/ledger/void", { pending_id: pendingId });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.status).toBe("voided");

    const after = await balanceOf(debit);
    expect(after.reserved_minor).toBe(0);
    expect(after.balance_minor).toBe(0);
  });

  it("idempotent replay: same idempotency_key returns the original reservation", async (ctx) => {
    if (!(await reachable(CFG.ledgerUrl, "/health"))) ctx.skip();

    const key = uniqueId("e2e-ledger-idem");
    const payload = {
      debit_account_id: randomUUID(),
      credit_account_id: randomUUID(),
      amount: 50_000,
      ledger: 1,
      code: 1,
      idempotency_key: key,
    };
    const first = await postJson(CFG.ledgerUrl, "/transfer", payload);
    expect(first.status).toBe(201);

    const replay = await postJson(CFG.ledgerUrl, "/transfer", payload);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.pending_id).toBe(first.body.pending_id);

    // And only one reservation exists: the pending amount is the amount ONCE.
    const bal = await balanceOf(payload.debit_account_id);
    expect(bal.reserved_minor).toBe(50_000);
  });
});

describe("recon-worker", () => {
  it("POST /recon/trigger runs a pass and GET /recon/last reports the same run", async (ctx) => {
    if (!(await reachable(CFG.reconUrl, "/health"))) ctx.skip(); // recon-worker absent

    const trigger = await postJson(CFG.reconUrl, "/recon/trigger", {});
    expect(trigger.status).toBe(200);
    expect(typeof trigger.body.run_id).toBe("string");
    expect(typeof trigger.body.total_checked).toBe("number");
    expect(typeof trigger.body.matched).toBe("number");
    expect(typeof trigger.body.discrepancies).toBe("number");

    const last = await getJson(CFG.reconUrl, "/recon/last");
    expect(last.status).toBe(200);
    expect(last.body.run_id).toBe(trigger.body.run_id);
  });
});

describe("api-gateway → commerce-engine proxy", () => {
  it("unauthenticated /api/v1 request → 401 in both auth modes", async (ctx) => {
    if (!(await reachable(CFG.gatewayUrl, "/health"))) ctx.skip();
    const { status } = await getJson(CFG.gatewayUrl, "/api/v1/products");
    expect(status).toBe(401);
  });

  it("authenticated /api/v1/products: proxied (never 502) — 404 pins the path mismatch, 401 = Keycloak mode", async (ctx) => {
    if (!(await reachable(CFG.gatewayUrl, "/health"))) ctx.skip();

    const jwt = await mintGatewayJwt({ sub: "e2e-gateway-probe", tenant_id: "e2e", role: "admin" });
    const { status } = await getJson(CFG.gatewayUrl, "/api/v1/products", {
      Authorization: `Bearer ${jwt}`,
    });

    // The upstream (commerce-engine) is healthy, so a proxy failure (502) is
    // never acceptable regardless of auth mode.
    expect(status).not.toBe(502);

    if (status === 404) {
      // Legacy HS256 mode (KEYCLOAK_URL unset): the minted token validated and
      // the request WAS proxied — but ForwardTo preserves the full
      // /api/v1/products URI while commerce-engine mounts /products, so the
      // upstream 404s. This pins the known path mismatch.
    } else if (status === 401) {
      // Keycloak mode: our HS256 minted token is rejected by JWKS/RS256 auth.
    }
    expect([401, 404]).toContain(status);
  });

  it.todo(
    "gateway GET /api/v1/products → 200 product-list contract. Blocked on the " +
      "path mismatch: ForwardTo (services/gateway/internal/proxy/proxy.go:32) " +
      "forwards the full request URI, while commerce-engine mounts /products " +
      "(services/commerce-engine/cmd/main.go:38). Fix by switching the route " +
      "to ForwardToStripPrefix (or mounting /api/v1 upstream), then assert " +
      "the 200 contract here.",
  );
});
