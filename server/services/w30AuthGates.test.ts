/**
 * W30 auth-gates — unit tests for the pure cores behind fixes
 * V2#2 (step-up), V2#8 (SSRF), V3#17 (storage policy + delivery PIN),
 * f9-f10#1 (OTP HMAC v2), V2#15 (sanctions polarity), V2#14 (capability tokens).
 */
import { describe, it, expect } from "vitest";
import { evaluateOutboundUrl, isPrivateIpv4, isPrivateIpv6 } from "./ssrfGuard";
import { sniffMime, isRiskyInlineType, servedContentPolicy } from "./storageSecurity";
import { makeCapabilityTokens } from "./capabilityTokens";
import { evaluateChallenge, withdrawalStepUpThreshold, type StepUpChallengeRow } from "./stepUp";
import { hashOtp, verifyOtpHash } from "../routers/phoneAuth";
import { hashDeliveryPin, verifyDeliveryPin, evaluatePinAttempt, MAX_PIN_ATTEMPTS_PER_DAY } from "../routers/logistics";
import { screenEntity, __resetSanctionsCache } from "./compliance/sanctions";

process.env.JWT_SECRET ||= "test-secret-for-w30-unit-tests-0123456789abcdef";

describe("ssrfGuard (V2#8)", () => {
  it("accepts public https URLs", () => {
    expect(evaluateOutboundUrl("https://odoo.example.com/rpc").ok).toBe(true);
  });
  it("rejects non-http schemes", () => {
    expect(evaluateOutboundUrl("file:///etc/passwd").ok).toBe(false);
    expect(evaluateOutboundUrl("gopher://x/").ok).toBe(false);
  });
  it("rejects private/loopback/link-local IPv4 literals", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
      expect(isPrivateIpv4(ip)).toBe(true);
      expect(evaluateOutboundUrl(`http://${ip}/latest/meta-data`).ok).toBe(false);
    }
  });
  it("accepts public IPv4 literals", () => {
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(evaluateOutboundUrl("https://8.8.8.8/").ok).toBe(true);
  });
  it("rejects private IPv6 and blocked hostnames", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
    expect(isPrivateIpv6("fd00::1")).toBe(true);
    expect(isPrivateIpv6("fe80::1")).toBe(true);
    expect(evaluateOutboundUrl("http://localhost:8069/").ok).toBe(false);
    expect(evaluateOutboundUrl("http://metadata.google.internal/").ok).toBe(false);
  });
  it("rejects malformed URLs", () => {
    expect(evaluateOutboundUrl("not a url").ok).toBe(false);
    expect(evaluateOutboundUrl("").ok).toBe(false);
  });
});

describe("storageSecurity (V3#17)", () => {
  it("sniffs HTML/SVG from magic content and forces attachment", () => {
    expect(sniffMime(Buffer.from("<!DOCTYPE html><html>"))).toBe("text/html");
    expect(sniffMime(Buffer.from("  <svg xmlns='x'>"))).toBe("image/svg+xml");
    const policy = servedContentPolicy("image/png", Buffer.from("<html><script>alert(1)</script>"));
    expect(policy.disposition).toBe("attachment");
  });
  it("flags risky stored types even without sniff match", () => {
    const policy = servedContentPolicy("image/svg+xml", Buffer.from([0x89, 0x50]));
    expect(policy.disposition).toBe("attachment");
  });
  it("serves genuine images inline with sniffed type", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const policy = servedContentPolicy("application/octet-stream", png);
    expect(policy).toEqual({ contentType: "image/png", disposition: "inline" });
  });
  it("isRiskyInlineType covers script-capable types", () => {
    expect(isRiskyInlineType("text/html; charset=utf-8")).toBe(true);
    expect(isRiskyInlineType("application/javascript")).toBe(true);
    expect(isRiskyInlineType("image/png")).toBe(false);
  });
});

describe("capabilityTokens (V2#14 + storage)", () => {
  const signer = makeCapabilityTokens("unit-secret");
  it("round-trips a token with exact type+resource binding", () => {
    const token = signer.sign({ type: "buyer_confirm", resource: "escrow-1" }, 600);
    expect(signer.verify(token, "buyer_confirm", "escrow-1")?.resource).toBe("escrow-1");
  });
  it("rejects wrong type, wrong resource, and forged tokens", () => {
    const token = signer.sign({ type: "buyer_confirm", resource: "escrow-1" }, 600);
    expect(signer.verify(token, "storage_cap", "escrow-1")).toBeNull();
    expect(signer.verify(token, "buyer_confirm", "escrow-2")).toBeNull();
    expect(makeCapabilityTokens("other-secret").verify(token, "buyer_confirm", "escrow-1")).toBeNull();
    expect(signer.verify("garbage", "buyer_confirm", "escrow-1")).toBeNull();
  });
});

describe("stepUp challenge core (V2#2)", () => {
  const row: StepUpChallengeRow = {
    id: "c1",
    tenantId: "t1",
    userId: "u1",
    purpose: "withdrawal",
    otpHash: "hash:123456",
    attempts: 0,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const verify = (stored: string, otp: string) => stored === `hash:${otp}`;
  const base = { userId: "u1", tenantId: "t1", purpose: "withdrawal", otp: "123456" };

  it("accepts a valid challenge", () => {
    expect(evaluateChallenge(row, base, verify).ok).toBe(true);
  });
  it("rejects consumed, expired, capped, scope-mismatched and bad-otp challenges", () => {
    expect(evaluateChallenge({ ...row, consumedAt: new Date() }, base, verify)).toEqual({ ok: false, reason: "consumed" });
    expect(evaluateChallenge({ ...row, expiresAt: new Date(Date.now() - 1000) }, base, verify)).toEqual({ ok: false, reason: "expired" });
    expect(evaluateChallenge({ ...row, attempts: 3 }, base, verify)).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(evaluateChallenge(row, { ...base, purpose: "payout_change" }, verify)).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(evaluateChallenge(row, { ...base, otp: "000000" }, verify)).toEqual({ ok: false, reason: "bad_otp" });
  });
  it("withdrawal threshold defaults to 100000 and is env-overridable", () => {
    expect(withdrawalStepUpThreshold({} as NodeJS.ProcessEnv)).toBe(100000);
    expect(withdrawalStepUpThreshold({ WITHDRAWAL_STEPUP_THRESHOLD: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });
});

describe("OTP hash v2 (f9-f10 F10-1)", () => {
  const pepper = "unit-pepper";
  it("produces salted HMAC hashes and verifies them", () => {
    const h1 = hashOtp("123456", pepper);
    const h2 = hashOtp("123456", pepper);
    expect(h1.startsWith("v2:")).toBe(true);
    expect(h1).not.toBe(h2); // per-OTP salt
    expect(verifyOtpHash(h1, "123456", pepper)).toBe(true);
    expect(verifyOtpHash(h1, "654321", pepper)).toBe(false);
  });
  it("remains migration-safe for legacy v1 unsalted sha256 rows", async () => {
    const { createHash } = await import("crypto");
    const legacy = createHash("sha256").update("123456" + pepper).digest("hex");
    expect(verifyOtpHash(legacy, "123456", pepper)).toBe(true);
    expect(verifyOtpHash(legacy, "000000", pepper)).toBe(false);
  });
});

describe("delivery PIN hardening (V3#17)", () => {
  it("stores only hashes and verifies timing-safe, migration-safe", () => {
    const hashed = hashDeliveryPin("4321", "ship-1");
    expect(hashed.startsWith("pinv1:")).toBe(true);
    expect(hashed).not.toContain("4321");
    expect(verifyDeliveryPin(hashed, "4321", "ship-1")).toBe(true);
    expect(verifyDeliveryPin(hashed, "1234", "ship-1")).toBe(false);
    // a hash salted for another shipment does not verify
    expect(verifyDeliveryPin(hashed, "4321", "ship-2")).toBe(false);
    // legacy plaintext rows still verify
    expect(verifyDeliveryPin("4321", "4321", "ship-1")).toBe(true);
  });
  it("caps attempts at 5/day and resets on a new day", () => {
    let meta: unknown = {};
    for (let i = 0; i < MAX_PIN_ATTEMPTS_PER_DAY; i++) {
      const r = evaluatePinAttempt(meta, new Date("2026-01-01T10:00:00Z"));
      expect(r.allowed).toBe(true);
      meta = r.nextMeta;
    }
    expect(evaluatePinAttempt(meta, new Date("2026-01-01T11:00:00Z")).allowed).toBe(false);
    expect(evaluatePinAttempt(meta, new Date("2026-01-02T00:00:00Z")).allowed).toBe(true);
  });
});

describe("sanctions fail-closed polarity (V2#15)", () => {
  it("treats unset NODE_ENV as production (degraded, not bundled stub)", async () => {
    __resetSanctionsCache();
    const res = await screenEntity(
      { name: "Acme Unlisted Trading" },
      { env: { SANCTIONS_LIST_URL: "" } as NodeJS.ProcessEnv, now: Date.now() },
    );
    // no remote list, NODE_ENV unset → fail-closed degraded hit, never bundled pass
    expect(res.degraded).toBe(true);
    expect(res.source).toBe("degraded");
  });
  it("bundled stub remains available only in explicit development/test", async () => {
    __resetSanctionsCache();
    const res = await screenEntity(
      { name: "Acme Unlisted Trading" },
      { env: { NODE_ENV: "development", SANCTIONS_LIST_URL: "" } as NodeJS.ProcessEnv },
    );
    expect(res.source).toBe("bundled");
  });
});
