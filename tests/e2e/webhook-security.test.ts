/**
 * WEBHOOK SECURITY — negative tests for signature/key enforcement on the
 * platform's inbound webhook surface.
 *
 * Current-main reality (verified at 626cb97):
 *   - /api/webhooks/paystack: the global express.json() (server/_core/index.ts:143)
 *     consumes the body BEFORE the route-level express.raw() (index.ts:440),
 *     so the HMAC is computed over a parsed object, crypto throws, and ANY
 *     JSON request gets a 500 — including ones with a valid signature.
 *     Requests are never ACCEPTED (good), but the strict 401/200 contract
 *     requires the webhook-hardening fix branch → those assertions are
 *     it.todo below; the it() tests pin the "never silently accepted" floor.
 *   - /api/webhooks/escrow-bank performs NO HMAC verification at all →
 *     it.todo for the fail-closed behavior.
 *   - /api/internal/events requires INTERNAL_API_KEY when configured →
 *     missing/wrong key = 401 today (express.json() is the correct parser
 *     for this route, so it works).
 */
import { describe, it, expect } from "vitest";
import { CFG, postRaw } from "./helpers/stack";

const PAYSTACK_BODY = JSON.stringify({
  event: "charge.success",
  data: { reference: "E2E-FAKE-REF-123" },
});

describe("POST /api/webhooks/paystack", () => {
  it("invalid signature is NEVER accepted as received (401 or 500, never 200)", async () => {
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY, {
      "x-paystack-signature": "deadbeef".repeat(16),
    });
    expect(status).not.toBe(200);
    expect(body?.received).not.toBe(true);
    expect(body).toHaveProperty("error");
  });

  it("missing signature header is NEVER accepted", async () => {
    const { status, body } = await postRaw(CFG.platformUrl, "/api/webhooks/paystack", PAYSTACK_BODY);
    expect(status).not.toBe(200);
    expect(body?.received).not.toBe(true);
  });

  it.todo(
    "invalid x-paystack-signature → exactly 401 { error: 'invalid-signature' }. " +
      "Blocked on current main: global express.json() (index.ts:143) runs " +
      "before the route's express.raw() (index.ts:440), so the HMAC is " +
      "computed over a parsed object and crypto throws → 500 for every " +
      "request. The webhook-hardening fix branch repairs the middleware " +
      "ordering + fail-closed behavior; enable once merged.",
  );

  it.todo(
    "valid HMAC-SHA512 signature → 200 { received: true } (positive control). " +
      "Blocked by the same express.json()/express.raw() ordering bug on " +
      "current main (valid requests also 500). Enable with the fix branch.",
  );

  it.todo(
    "requests are rejected (401/503) when PAYSTACK_WEBHOOK_SECRET is unset — " +
      "current main verifies nothing without the secret (fail-open). " +
      "Fail-closed behavior lands with the webhook-hardening fix branch.",
  );
});

describe("POST /api/webhooks/escrow-bank", () => {
  it.todo(
    "settlement callback without a valid HMAC → 401/503 — current main " +
      "performs NO signature verification on /api/webhooks/escrow-bank " +
      "(any caller who knows an escrowId can mark it settled). Fail-closed " +
      "HMAC verification lands with the webhook-hardening fix branch; " +
      "enable this test once it merges.",
  );

  it("malformed body (missing escrowId/bankRef) → 400, never a crash", async () => {
    // Documents the input-validation floor that already exists today.
    const { status, body } = await postRaw(
      CFG.platformUrl, "/api/webhooks/escrow-bank", JSON.stringify({ status: "settled" }),
    );
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

  it.todo(
    "no key + INTERNAL_API_KEY unset → 503 fail-closed (currently only in " +
      "NODE_ENV=production/staging; the e2e stack runs NODE_ENV=test with a " +
      "key configured). Covered by the webhook-hardening branch's config.",
  );
});
