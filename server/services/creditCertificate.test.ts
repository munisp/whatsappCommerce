/**
 * W27 credit — certificate signing/rendering unit tests (pure parts).
 * The db-backed issuance path is covered by journey J138/J139 flows and the
 * credit router.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalStringify,
  signPayload,
  verifyPayload,
  renderCertificateHtml,
  type CreditCertificatePayload,
} from "./creditCertificate";

const SECRET = "test-secret-0123456789";

function payload(over: Partial<CreditCertificatePayload> = {}): CreditCertificatePayload {
  return {
    version: 1,
    issuer: "whatsappCommerce",
    tenantId: "t1",
    merchantId: "m1",
    merchantName: "Sim Store",
    issuedAt: "2026-02-15T00:00:00.000Z",
    score: 725,
    scoreScale: { min: 0, max: 1000 },
    factors: {
      orderVolume: { points: 144, weight: 200, completedOrders: 36, saturation: 50 },
      completionRate: { points: 135, weight: 150, ratePct: 90, considered: 40 },
      codCollectionRate: { points: 135, weight: 150, ratePct: 90, codOrders: 10 },
      paymentSuccessRate: { points: 144, weight: 150, ratePct: 96, attempts: 26 },
      refundDisputeRate: { points: 112, weight: 150, adverseEvents: 2, ratePct: 5 },
      tenure: { points: 55, weight: 100, days: 200, saturation: 365 },
      trustScore: { points: 80, weight: 100, trustScore: 80 },
      salesVolumeCents90d: 12_345_600,
      ordersConsidered: 40,
    },
    history: { windowDays: 90, ordersTotal: 40, ordersDelivered: 36, salesVolumeCents: 12_345_600, currency: "NGN" },
    loans: [],
    totals: { loansCount: 0, loansRepaidCount: 0, loansDefaultedCount: 0, principalBorrowedCents: 0, principalRepaidCents: 0 },
    ...over,
  };
}

describe("canonicalStringify", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalStringify({ b: 1, a: { d: [2, 1], c: null } }))
      .toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
  it("is stable regardless of key insertion order", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });
});

describe("signPayload / verifyPayload", () => {
  it("produces a deterministic hex HMAC-SHA256", () => {
    const a = signPayload(payload(), SECRET);
    const b = signPayload(payload(), SECRET);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPayload(payload(), a.signature, SECRET)).toBe(true);
  });
  it("detects tampering and wrong secrets", () => {
    const { signature } = signPayload(payload(), SECRET);
    expect(verifyPayload(payload({ score: 726 }), signature, SECRET)).toBe(false);
    expect(verifyPayload(payload(), signature, "other-secret")).toBe(false);
  });
});

describe("renderCertificateHtml", () => {
  it("renders score, factors, totals and signature; escapes HTML", () => {
    const p = payload({ merchantName: '<script>alert("x")</script>' });
    const html = renderCertificateHtml(p, "deadbeef".repeat(8), "cert-1");
    expect(html).toContain("725");
    expect(html).toContain("Order volume");
    expect(html).toContain("cert-1");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("shows an empty loan table gracefully", () => {
    expect(renderCertificateHtml(payload(), "sig", "c")).toContain("No loans on record");
  });
});
