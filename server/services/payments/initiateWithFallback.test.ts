/**
 * initiateWithFallback.test.ts — wave-11 fallback orchestrator:
 *  - priority chain iteration, throw → next, ok:false → next
 *  - serving provider recorded; preferred provider tried first
 *  - empty tenant chain → env-default chain (platform paystack)
 *  - all providers fail → ProviderChainExhaustedError with attempts
 *  - observability warn per failed hop
 *  - W45 (PAY-25): ambiguous failures are VERIFIED (fetchStatus) before any
 *    fallback hop — live checkout at A → recovered without a second mint;
 *    inconclusive verify → chain ABORTS instead of risking two checkouts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ENV } from "../../_core/env";
import type { PaymentInitiateCtx, PaymentProvider } from "./providers/types";

const registryMock = vi.hoisted(() => ({
  getProviderForTenant: vi.fn(),
  getProviderAdapter: vi.fn(),
}));
vi.mock("./providers/registry", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getProviderForTenant: registryMock.getProviderForTenant, getProviderAdapter: registryMock.getProviderAdapter };
});
// Keep custom.ts import side-effect-free in this isolated test.
vi.mock("./providers/custom", () => ({}));

const captureSpy = vi.hoisted(() => vi.fn());
vi.mock("../observability", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, captureException: captureSpy };
});

import { initiateWithFallback, ProviderChainExhaustedError } from "./initiateWithFallback";

const CTX: PaymentInitiateCtx = {
  tenantId: "t1",
  amountCents: 5000,
  currency: "NGN",
  reference: "REF-1",
  metadata: { payment_intent_id: "pi-1", kind: "credit_repayment", accountId: "acct-1" },
  customer: { phone: "+2348000000000", email: "b@wa.commerce" },
};

function adapter(
  id: string,
  behaviour: "ok" | "throw" | "notok",
  verify: "pending" | "success" | "failed" | "throw" = "failed",
): PaymentProvider {
  return {
    id,
    displayName: id,
    async initiate(ctx) {
      if (behaviour === "throw") throw new Error(`${id} network down`);
      if (behaviour === "notok") {
        // W45: an unclassified ok:false is treated as AMBIGUOUS (fail-safe) —
        // mark explicitly definitive to model an answered refusal.
        return { ok: false, reference: ctx.reference, provider: id, failureKind: "definitive" as const };
      }
      return { ok: true, reference: ctx.reference, provider: id, authorizationUrl: `https://pay.example/${id}` };
    },
    verifyWebhook: () => ({ ok: false, reference: "", amountCents: 0, metadata: {} }),
    async fetchStatus() {
      if (verify === "throw") throw new Error(`${id} verify unreachable`);
      return { status: verify, amountCents: 0 };
    },
    testConnection: async () => ({ ok: true }),
  };
}

const entry = (id: string, b: "ok" | "throw" | "notok", priority = 0, verify: "pending" | "success" | "failed" | "throw" = "failed") => ({
  provider: adapter(id, b, verify),
  creds: { secretKey: "sk" },
  config: { priority },
});

beforeEach(() => {
  vi.clearAllMocks();
  ENV.paystackSecretKey = "";
  ENV.flwSecretKey = "";
});

describe("initiateWithFallback", () => {
  it("serves via the primary provider when it succeeds", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([entry("paystack", "ok", 10), entry("flutterwave", "ok", 5)]);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("paystack");
    expect(out.result.authorizationUrl).toBe("https://pay.example/paystack");
    expect(out.failedAttempts).toEqual([]);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("first provider throws → second serves; failure recorded + warn captured", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([entry("paystack", "throw"), entry("flutterwave", "ok")]);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("flutterwave");
    expect(out.failedAttempts[0].provider).toBe("paystack");
    expect(out.failedAttempts[0].error).toContain("paystack network down");
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy.mock.calls[0][1]).toMatchObject({ severity: "warn", operation: "providerFallback" });
  });

  it("ok:false (gateway rejection) falls through to the next provider", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([entry("paystack", "notok"), entry("manual", "ok")]);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("manual");
    expect(out.failedAttempts[0].provider).toBe("paystack");
  });

  it("preferred provider is tried first, others remain fallbacks", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([entry("paystack", "ok"), entry("flutterwave", "ok")]);
    const out = await initiateWithFallback("t1", CTX, { preferredProvider: "flutterwave" });
    expect(out.providerId).toBe("flutterwave");
  });

  it("preferred provider not in the chain → chain order unchanged", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([entry("paystack", "ok")]);
    const out = await initiateWithFallback("t1", CTX, { preferredProvider: "stripe" });
    expect(out.providerId).toBe("paystack");
  });

  it("all providers fail → ProviderChainExhaustedError listing every attempt", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([entry("paystack", "throw"), entry("flutterwave", "notok")]);
    const err = await initiateWithFallback("t1", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderChainExhaustedError);
    expect(err.attempts).toHaveLength(2);
    expect(String(err.message)).toContain("paystack");
    expect(String(err.message)).toContain("flutterwave");
    expect(captureSpy).toHaveBeenCalledTimes(2);
  });

  it("empty tenant chain + no env keys → exhausted with zero attempts", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([]);
    const err = await initiateWithFallback("t1", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderChainExhaustedError);
    expect(err.attempts).toHaveLength(0);
  });

  it("empty tenant chain falls back to the env-default paystack adapter", async () => {
    ENV.paystackSecretKey = "sk_env";
    registryMock.getProviderForTenant.mockResolvedValue([]);
    registryMock.getProviderAdapter.mockImplementation((id: string) =>
      id === "paystack" ? adapter("paystack", "ok") : undefined);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("paystack");
    expect(registryMock.getProviderAdapter).toHaveBeenCalledWith("paystack");
  });

  // ── W45 (PAY-25) verify-before-fallback ─────────────────────────────────

  it("ambiguous failure + verify shows live checkout → recovered at provider A, NO second mint", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([
      entry("paystack", "throw", 10, "pending"), // timed out, but tx exists pending
      entry("flutterwave", "ok", 5),
    ]);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("paystack");
    expect(out.recoveredViaVerify).toBe(true);
    expect(out.result.ok).toBe(true);
    // Flutterwave was NEVER asked to initiate — no duplicate checkout.
    expect(out.failedAttempts.map((a) => a.provider)).toEqual(["paystack"]);
  });

  it("ambiguous failure + verify failed → definitive → fallback hop", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([
      entry("paystack", "throw", 10, "failed"),
      entry("flutterwave", "ok", 5),
    ]);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("flutterwave");
    expect(out.recoveredViaVerify).toBeUndefined();
  });

  it("ambiguous failure + inconclusive verify → chain ABORTS (no blind fallback)", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([
      entry("paystack", "throw", 10, "throw"),
      entry("flutterwave", "ok", 5),
    ]);
    const err = await initiateWithFallback("t1", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderChainExhaustedError);
    // Only the ambiguous provider was attempted — flutterwave never minted.
    expect(err.attempts).toHaveLength(1);
    expect(err.attempts[0].provider).toBe("paystack");
    expect(err.attempts[0].error).toContain("verify inconclusive");
    const critical = captureSpy.mock.calls.find((c) => c[1]?.operation === "fallbackRefused");
    expect(critical?.[1]).toMatchObject({ severity: "critical" });
  });

  it("definitive ok:false hops WITHOUT any verify probe", async () => {
    const flwInitiate = vi.fn().mockResolvedValue({ ok: true, reference: CTX.reference, provider: "flutterwave" });
    registryMock.getProviderForTenant.mockResolvedValue([
      entry("paystack", "notok", 10),
      { provider: { ...adapter("flutterwave", "ok"), initiate: flwInitiate }, creds: { secretKey: "sk" }, config: { priority: 5 } },
    ]);
    const out = await initiateWithFallback("t1", CTX);
    expect(out.providerId).toBe("flutterwave");
    expect(flwInitiate).toHaveBeenCalledTimes(1);
  });
});
