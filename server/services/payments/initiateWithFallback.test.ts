/**
 * initiateWithFallback.test.ts — wave-11 fallback orchestrator:
 *  - priority chain iteration, throw → next, ok:false → next
 *  - serving provider recorded; preferred provider tried first
 *  - empty tenant chain → env-default chain (platform paystack)
 *  - all providers fail → ProviderChainExhaustedError with attempts
 *  - observability warn per failed hop
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

function adapter(id: string, behaviour: "ok" | "throw" | "notok"): PaymentProvider {
  return {
    id,
    displayName: id,
    async initiate(ctx) {
      if (behaviour === "throw") throw new Error(`${id} network down`);
      if (behaviour === "notok") return { ok: false, reference: ctx.reference, provider: id };
      return { ok: true, reference: ctx.reference, provider: id, authorizationUrl: `https://pay.example/${id}` };
    },
    verifyWebhook: () => ({ ok: false, reference: "", amountCents: 0, metadata: {} }),
    fetchStatus: async () => ({ status: "pending" as const, amountCents: 0 }),
    testConnection: async () => ({ ok: true }),
  };
}

const entry = (id: string, b: "ok" | "throw" | "notok", priority = 0) => ({
  provider: adapter(id, b),
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
    expect(out.failedAttempts).toEqual([{ provider: "paystack", error: "paystack network down" }]);
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
});
