/**
 * WEBHOOK SECURITY — signature/key enforcement on the platform's inbound
 * webhook surface (F4).
 *
 * Contract under test (server/_core/index.ts):
 *   - /api/webhooks/paystack: HMAC-SHA512 over the RAW body, compared
 *     timing-safe against PAYSTACK_WEBHOOK_SECRET via x-paystack-signature.
 *     Invalid/missing signature → 401 { error: "invalid-signature" }.
 *     Valid signature → 200 { received: true, ... }.
 *   - /api/webhooks/escrow-bank: HMAC-SHA256 over the raw body against
 *     ESCROW_BANK_WEBHOOK_SECRET via x-escrow-bank-signature (x-signature
 *     also accepted). Invalid → 401 { error: "invalid-signature" }.
 *   - Both fail CLOSED (503 webhook-secret-not-configured) when the secret
 *     is unset in production/staging (requireWebhookSecret).
 *   - /api/internal/events requires INTERNAL_API_KEY when configured.
 *
 * Paystack does not sign a timestamp; replay/tamper resistance comes from
 * the signature being bound to the exact raw body — covered below by the
 * tampered-body test (replayed signature over a modified body → 401).
 *
 * The two "secret unset → fail closed" tests are gated on env flags because
 * the standard e2e stack has the secrets configured; run them against a
 * stack launched WITHOUT the secrets (E2E_*_UNSET=1) to verify the
 * fail-closed path end to end.
 */
import { createHmac } from "crypto";
import { describe, it, expect } from "vitest";
import { CFG, postRaw } from "./helpers/stack";

const PAYSTACK_BODY = JSON.stringify({
  event: "charge.success",
  data: { reference: "E2E-FAKE-REF-123" },
});

function hmacHex(algo: "sha256" | "sha512", secret: string, raw: string): string {
  return createHmac(algo, secret).update(raw, "utf8").digest("hex");
}

describe("POST /api/webhooks/paystack", () => {
  it("invalid x-paystack-signature → exactly 401 { error: 'invalid-signature' }", async () => {
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY, {
      "x-paystack-signature": "deadbeef".repeat(16),
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "invalid-signature" });
    expect(body?.received).not.toBe(true);
  });

  it("signature computed with the WRONG secret → 401", async () => {
    const badSig = hmacHex("sha512", "not-the-webhook-secret", PAYSTACK_BODY);
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY, {
      "x-paystack-signature": badSig,
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "invalid-signature" });
  });

  it("missing signature header → 401, never accepted", async () => {
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY);
    expect(status).toBe(401);
    expect(body?.received).not.toBe(true);
  });

  it("valid HMAC-SHA512 signature → 200 with received: true (positive control)", async () => {
    const sig = hmacHex("sha512", CFG.paystackWebhookSecret, PAYSTACK_BODY);
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY, {
      "x-paystack-signature": sig,
    });
    expect(status).toBe(200);
    expect(body?.received).toBe(true);
  });

  it("replayed signature over a TAMPERED body → 401 (signature is bound to the raw body)", async () => {
    // Capture a valid signature for the original body, then replay it against
    // a modified body (amount changed) — the signature must no longer match.
    const sig = hmacHex("sha512", CFG.paystackWebhookSecret, PAYSTACK_BODY);
    const tampered = JSON.stringify({
      event: "charge.success",
      data: { reference: "E2E-FAKE-REF-123", amount: 999999900 },
    });
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", tampered, {
      "x-paystack-signature": sig,
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "invalid-signature" });
  });

  it.runIf(process.env.E2E_PAYSTACK_SECRET_UNSET === "1")(
    "PAYSTACK_WEBHOOK_SECRET unset → request is rejected 401/503 (fail closed)",
    async () => {
      // Run against a stack launched WITHOUT PAYSTACK_WEBHOOK_SECRET
      // (E2E_PAYSTACK_SECRET_UNSET=1). NODE_ENV must not be development/test
      // for the fail-closed path to engage.
      const sig = hmacHex("sha512", CFG.paystackWebhookSecret, PAYSTACK_BODY);
      const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY, {
        "x-paystack-signature": sig,
      });
      expect([401, 503]).toContain(status);
      expect(body?.received).not.toBe(true);
    },
  );
});

describe("POST /api/webhooks/escrow-bank", () => {
  const SETTLE_BODY = JSON.stringify({
    escrowId: "00000000-0000-0000-0000-000000000000",
    bankRef: "E2E-FAKE-BANKREF",
    status: "settled",
  });

  it("settlement callback without a valid HMAC → 401 { error: 'invalid-signature' }", async () => {
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/escrow-bank", SETTLE_BODY);
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "invalid-signature" });
  });

  it("settlement callback with a wrong-secret HMAC → 401", async () => {
    const badSig = hmacHex("sha256", "not-the-escrow-secret", SETTLE_BODY);
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/escrow-bank", SETTLE_BODY, {
      "x-escrow-bank-signature": badSig,
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "invalid-signature" });
  });

  it("validly-signed callback with unknown escrowId → 404, never a crash", async () => {
    const sig = hmacHex("sha256", CFG.escrowBankWebhookSecret, SETTLE_BODY);
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/escrow-bank", SETTLE_BODY, {
      "x-escrow-bank-signature": sig,
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "escrow-not-found" });
  });

  it("malformed body (missing escrowId/bankRef) with a valid signature → 400, never a crash", async () => {
    const malformed = JSON.stringify({ status: "settled" });
    const sig = hmacHex("sha256", CFG.escrowBankWebhookSecret, malformed);
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/escrow-bank", malformed, {
      "x-escrow-bank-signature": sig,
    });
    expect(status).toBe(400);
    expect(String(body?.error ?? "")).toContain("Missing escrowId or bankRef");
  });
});

describe("POST /api/internal/events", () => {
  const EVENT = {
    topic: "e2e.test",
    offset: 1,
    partition: 0,
    eventType: "e2e.ping",
    payload: { hello: "world" },
  };

  it("no API key → 401 invalid-internal-api-key", async () => {
    const { status, body } = await postRaw(
      CFG.platformUrl, "/api/internal/events", JSON.stringify(EVENT),
    );
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "invalid-internal-api-key" });
  });

  it("wrong API key → 401", async () => {
    const { status } = await postRaw(
      CFG.platformUrl, "/api/internal/events", JSON.stringify(EVENT),
      { "x-internal-api-key": "not-the-key" },
    );
    expect(status).toBe(401);
  });

  it("correct API key → 200 with recorded count (positive control)", async () => {
    const { status, body } = await postRaw(
      CFG.platformUrl,
      "/api/internal/events",
      JSON.stringify({ events: [EVENT] }),
      { "x-internal-api-key": CFG.internalApiKey },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, recorded: 1, received: 1 });
  });

  it.runIf(process.env.E2E_INTERNAL_KEY_UNSET === "1")(
    "no key + INTERNAL_API_KEY unset → 503 fail-closed (production-like stack)",
    async () => {
      // Run against a production-like stack launched WITHOUT INTERNAL_API_KEY
      // (E2E_INTERNAL_KEY_UNSET=1).
      const { status, body } = await postRaw(
        CFG.platformUrl, "/api/internal/events", JSON.stringify(EVENT),
      );
      expect(status).toBe(503);
      expect(body).toMatchObject({ error: "internal-api-not-configured" });
    },
  );
});
