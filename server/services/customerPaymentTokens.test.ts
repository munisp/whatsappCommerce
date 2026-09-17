/**
 * W41 Coder A (UC-6) — tokenized customer payment methods: consent-gated
 * save (encrypted v1:, never a PAN), reusable-authorization extraction from
 * provider payloads, list/revoke behavior with a minimal chainable db mock.
 */
import { describe, it, expect } from "vitest";
import {
  extractReusableAuthorization,
  saveCustomerToken,
  listCustomerTokens,
  revokeCustomerToken,
  tokenConsentPrompt,
} from "./customerPaymentTokens";
import { decryptSecret, isEncrypted } from "./crypto/secrets";

// Minimal chainable db mock honoring the exact drizzle surface the module uses.
function mockDb(rows: { tokens?: any[] } = {}) {
  const tokens = rows.tokens ?? [];
  return {
    inserted: [] as any[],
    tokens,
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `tok-${tokens.length + 1}`, ...v };
          tokens.push(row);
          return [row];
        },
      }),
    }),
    select: (fields?: any) => ({
      from: () => ({
        where: () => ({
          limit: async () => tokens,
          orderBy: async () =>
            tokens.map((t) => (fields ? Object.fromEntries(Object.keys(fields).map((k) => [k, t[k]])) : t)),
        }),
      }),
    }),
    update: () => ({
      set: (v: any) => ({
        where: () => ({
          returning: async () => [{ id: tokens[0]?.id ?? "tok-1" }],
        }),
      }),
    }),
  };
}

describe("extractReusableAuthorization", () => {
  it("paystack: reusable authorization → token + masked label", () => {
    const res = extractReusableAuthorization("paystack", {
      authorization: { reusable: true, authorization_code: "AUTH_abc123", brand: "visa", last4: "4081" },
    });
    expect(res).toEqual({ token: "AUTH_abc123", displayLabel: "visa •••• 4081" });
  });

  it("paystack: non-reusable authorization → null (honest nothing-to-save)", () => {
    expect(extractReusableAuthorization("paystack", {
      authorization: { reusable: false, authorization_code: "AUTH_x", last4: "4081" },
    })).toBeNull();
    expect(extractReusableAuthorization("paystack", {})).toBeNull();
  });

  it("flutterwave: card token → token + masked label", () => {
    const res = extractReusableAuthorization("flutterwave", {
      card: { token: "flw-tok-9", type: "mastercard", last_4digits: "1234" },
    });
    expect(res).toEqual({ token: "flw-tok-9", displayLabel: "mastercard •••• 1234" });
  });

  it("fake provider (dev): fakeAuthorization only outside prod", () => {
    const res = extractReusableAuthorization("fake", { fakeAuthorization: { token: "fake-1", label: "Dev card" } });
    if (process.env.NODE_ENV === "production") expect(res).toBeNull();
    else expect(res).toEqual({ token: "fake-1", displayLabel: "Dev card" });
  });
});

describe("saveCustomerToken (consent-gated, encrypted, never a PAN)", () => {
  const base = {
    tenantId: "t1",
    buyerPhone: "+2348000000001",
    provider: "paystack",
    token: "AUTH_reusable_1",
    displayLabel: "visa •••• 4081",
    consentText: tokenConsentPrompt("visa •••• 4081"),
  };

  it("refuses without explicit consent (fail closed)", async () => {
    await expect(saveCustomerToken(mockDb(), { ...base, consentText: "" })).rejects.toThrowError(/consent/);
    await expect(saveCustomerToken(mockDb(), { ...base, consentText: "ok" })).rejects.toThrowError(/consent/);
  });

  it("refuses a PAN-like value", async () => {
    await expect(saveCustomerToken(mockDb(), { ...base, token: "5399 8300 0000 0008" }))
      .rejects.toThrowError(/card number/);
  });

  it("stores the token encrypted v1: (decryptable, never plaintext)", async () => {
    const db = mockDb();
    const row = await saveCustomerToken(db, base);
    expect(row.tokenEnc).not.toBe(base.token);
    expect(isEncrypted(row.tokenEnc)).toBe(true);
    expect(row.tokenEnc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(row.tokenEnc)).toBe(base.token);
    expect(row.consentText).toBe(base.consentText);
    expect(row.status).toBe("active");
  });
});

describe("listCustomerTokens", () => {
  it("returns safe fields only — never the raw token", async () => {
    const db = mockDb({
      tokens: [{
        id: "tok-1", provider: "paystack", displayLabel: "visa •••• 4081",
        consentAt: new Date(), lastUsedAt: null, tokenEnc: "v1:secret",
      }],
    });
    const list = await listCustomerTokens(db, "t1", "+2348000000001");
    expect(list).toHaveLength(1);
    expect(list[0].displayLabel).toBe("visa •••• 4081");
    expect(JSON.stringify(list[0])).not.toContain("v1:secret");
    expect((list[0] as any).tokenEnc).toBeUndefined();
  });
});

describe("revokeCustomerToken", () => {
  it("flips an active token (claim-first) and reports ok", async () => {
    const db = mockDb({
      tokens: [{
        id: "tok-1", tenantId: "t1", buyerPhone: "+2348000000001", provider: "fake",
        status: "active", tokenEnc: "v1:x",
      }],
    });
    const res = await revokeCustomerToken(db, { tenantId: "t1", buyerPhone: "+2348000000001", tokenId: "tok-1" });
    expect(res.ok).toBe(true);
  });

  it("fails closed for a missing/revoked token", async () => {
    const db = mockDb({ tokens: [] });
    const res = await revokeCustomerToken(db, { tenantId: "t1", buyerPhone: "+2348000000001", tokenId: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("token_not_found");
  });
});

describe("tokenConsentPrompt", () => {
  it("names the masked label and the revoke path", () => {
    const p = tokenConsentPrompt("visa •••• 4081");
    expect(p).toContain("visa •••• 4081");
    expect(p).toContain("YES");
    expect(p.toLowerCase()).toContain("my cards");
  });
});
