/**
 * providerChain.test.ts — ProviderSettings UI logic:
 *  - fallback-chain ordering (priority DESC, enabled only, name tiebreak)
 *  - preview labels ("1. X (primary) → 2. Y (fallback)")
 *  - secret masking + keep-sentinel detection
 *  - custom-gateway JSON config validation (errors surface with hints)
 */
import { describe, it, expect } from "vitest";
import {
  MASKED_SECRET,
  orderFallbackChain,
  fallbackChainPreview,
  maskSecret,
  isMaskedSentinel,
  validateCustomConfig,
  type TenantProviderView,
} from "./providerChain";

const pv = (provider: string, priority: number, enabled = true): TenantProviderView => ({
  provider,
  displayName: provider[0].toUpperCase() + provider.slice(1),
  enabled,
  priority,
});

describe("orderFallbackChain", () => {
  it("orders by priority DESC (higher tried first) — mirrors the server registry", () => {
    const chain = orderFallbackChain([pv("flutterwave", 5), pv("paystack", 10), pv("manual", 1)]);
    expect(chain.map((p) => p.provider)).toEqual(["paystack", "flutterwave", "manual"]);
  });

  it("excludes disabled providers", () => {
    const chain = orderFallbackChain([pv("paystack", 10), pv("stripe", 20, false)]);
    expect(chain.map((p) => p.provider)).toEqual(["paystack"]);
  });

  it("breaks priority ties by display name (deterministic)", () => {
    const chain = orderFallbackChain([pv("stripe", 5), pv("monnify", 5)]);
    expect(chain.map((p) => p.provider)).toEqual(["monnify", "stripe"]);
  });
});

describe("fallbackChainPreview", () => {
  it("labels primary and fallbacks", () => {
    expect(fallbackChainPreview([pv("paystack", 10), pv("flutterwave", 5)])).toEqual([
      "1. Paystack (primary)",
      "2. Flutterwave (fallback)",
    ]);
  });

  it("empty chain → empty preview (UI shows the platform-default hint)", () => {
    expect(fallbackChainPreview([])).toEqual([]);
    expect(fallbackChainPreview([pv("paystack", 1, false)])).toEqual([]);
  });
});

describe("maskSecret / isMaskedSentinel", () => {
  it("never renders a real secret", () => {
    expect(maskSecret("sk_live_123")).toBe(MASKED_SECRET);
    expect(maskSecret("")).toBe("—");
    expect(maskSecret(null)).toBe("—");
  });

  it("detects the masked sentinel for keep-on-write", () => {
    expect(isMaskedSentinel(MASKED_SECRET)).toBe(true);
    expect(isMaskedSentinel(` ${MASKED_SECRET} `)).toBe(true);
    expect(isMaskedSentinel("sk_live_new")).toBe(false);
  });
});

describe("validateCustomConfig", () => {
  it("accepts a valid config with instructions", () => {
    const r = validateCustomConfig('{"instructions": "Pay to GTB", "baseUrl": "https://api.gw.example"}');
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ instructions: "Pay to GTB" });
  });

  it("rejects invalid JSON with the parser error", () => {
    const r = validateCustomConfig("{not json");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("Invalid JSON");
  });

  it("rejects non-object JSON", () => {
    expect(validateCustomConfig("[1,2]").ok).toBe(false);
    expect(validateCustomConfig('"str"').ok).toBe(false);
    expect(validateCustomConfig("").errors[0]).toContain("empty");
  });

  it("rejects a non-string instructions field", () => {
    const r = validateCustomConfig('{"instructions": 42}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("instructions");
  });

  it("rejects a non-http(s) baseUrl", () => {
    const r = validateCustomConfig('{"baseUrl": "ftp://x"}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("baseUrl");
  });

  it("hints when neither instructions nor baseUrl is present", () => {
    const r = validateCustomConfig('{"apiKey": "abc"}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("instructions");
  });
});
