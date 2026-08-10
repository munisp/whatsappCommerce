/**
 * w11 provider core tests — adapter conformance, paystack HMAC (fail-closed),
 * manual instructions, registry ordering/fallback, encrypted creds round-trip.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { PaymentProvider } from "./types";
import { paystackProvider } from "./paystack";
import { manualProvider, renderManualInstructions } from "./manual";

// ── Registry db mock (rows are swapped per test) ────────────────────────────
let configRows: any[] = [];
let lastInsertValues: any = null;
vi.mock("../../../db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          // Mimic SQL ORDER BY priority DESC, createdAt ASC.
          orderBy: async () =>
            [...configRows].sort(
              (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
            ),
          // Manual upsert's existence probe (select-then-insert/update).
          limit: async () => configRows.slice(0, 1),
        }),
      }),
    }),
    update: () => ({
      set: (s: any) => ({
        where: async () => {
          if (configRows[0]) Object.assign(configRows[0], s);
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        lastInsertValues = v;
        return { onConflictDoUpdate: async () => {} };
      },
    }),
  }),
}));

import {
  registerProvider,
  listProviderAdapters,
  getProviderAdapter,
  getProviderForTenant,
  upsertTenantProviderConfig,
} from "./registry";

const TEST_MASTER_KEY = Buffer.from("a".repeat(32)).toString("base64");

function hmac(body: string, secret: string): string {
  return createHmac("sha512", secret).update(body).digest("hex");
}

const CHARGE = {
  event: "charge.success",
  data: { reference: "PAY-123", amount: 50000, currency: "NGN", metadata: { tenant_id: "t1", order_id: "o1" } },
};

function mockFetchOnce(impl: (url: string, init?: any) => Promise<any>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Paystack adapter ───────────────────────────────────────────────────────
describe("paystack adapter", () => {
  const creds = { secretKey: "sk_test_123", webhookSecret: "whsec" };

  it("conforms to PaymentProvider", () => {
    const p: PaymentProvider = paystackProvider;
    expect(p.id).toBe("paystack");
    expect(typeof p.displayName).toBe("string");
    expect(typeof p.initiate).toBe("function");
    expect(typeof p.verifyWebhook).toBe("function");
    expect(typeof p.fetchStatus).toBe("function");
    expect(typeof p.testConnection).toBe("function");
  });

  it("initiate returns authorizationUrl with correct payload", async () => {
    const f = mockFetchOnce(async () => ({
      ok: true,
      json: async () => ({ status: true, data: { authorization_url: "https://paystack.co/pay/x", reference: "PAY-123" } }),
    }));
    const r = await paystackProvider.initiate(
      {
        tenantId: "t1", amountCents: 50000, currency: "NGN", reference: "PAY-123",
        metadata: { order_id: "o1" }, customer: { phone: "+2348012345678" },
        callbackUrl: "https://app.example/cb",
      },
      creds,
    );
    expect(r).toEqual({ ok: true, reference: "PAY-123", authorizationUrl: "https://paystack.co/pay/x", provider: "paystack" });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect(init.headers.Authorization).toBe("Bearer sk_test_123");
    const body = JSON.parse(init.body);
    expect(body.amount).toBe(50000); // minor units, unchanged
    expect(body.reference).toBe("PAY-123");
    expect(body.email).toBe("2348012345678@wa.commerce");
    expect(body.callback_url).toBe("https://app.example/cb");
    expect(body.metadata).toEqual({ order_id: "o1" });
  });

  it("initiate uses customer.email when provided", async () => {
    const f = mockFetchOnce(async () => ({
      ok: true, json: async () => ({ status: true, data: { authorization_url: "u" } }),
    }));
    await paystackProvider.initiate(
      { tenantId: "t1", amountCents: 100, currency: "NGN", reference: "R", metadata: {}, customer: { phone: "1", email: "a@b.c" } },
      creds,
    );
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).email).toBe("a@b.c");
  });

  it("initiate fails closed without secretKey", async () => {
    const r = await paystackProvider.initiate(
      { tenantId: "t1", amountCents: 100, currency: "NGN", reference: "R", metadata: {}, customer: { phone: "1" } },
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.provider).toBe("paystack");
  });

  it("initiate returns ok:false on HTTP error", async () => {
    mockFetchOnce(async () => ({ ok: false, status: 502, text: async () => "bad gateway" }));
    const r = await paystackProvider.initiate(
      { tenantId: "t1", amountCents: 100, currency: "NGN", reference: "R", metadata: {}, customer: { phone: "1" } },
      creds,
    );
    expect(r.ok).toBe(false);
  });

  it("initiate returns ok:false when Paystack status=false", async () => {
    mockFetchOnce(async () => ({ ok: true, json: async () => ({ status: false }) }));
    const r = await paystackProvider.initiate(
      { tenantId: "t1", amountCents: 100, currency: "NGN", reference: "R", metadata: {}, customer: { phone: "1" } },
      creds,
    );
    expect(r.ok).toBe(false);
  });

  it("initiate returns ok:false on network throw", async () => {
    mockFetchOnce(async () => { throw new Error("ECONNRESET"); });
    const r = await paystackProvider.initiate(
      { tenantId: "t1", amountCents: 100, currency: "NGN", reference: "R", metadata: {}, customer: { phone: "1" } },
      creds,
    );
    expect(r.ok).toBe(false);
  });

  it("verifyWebhook accepts a valid charge.success", () => {
    const raw = JSON.stringify(CHARGE);
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "whsec") }, raw, creds);
    expect(n).toEqual({ ok: true, reference: "PAY-123", amountCents: 50000, metadata: { tenant_id: "t1", order_id: "o1" } });
  });

  it("verifyWebhook rejects a bad signature (fail closed)", () => {
    const raw = JSON.stringify(CHARGE);
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "wrong") }, raw, creds);
    expect(n.ok).toBe(false);
  });

  it("verifyWebhook rejects a missing signature (fail closed)", () => {
    const n = paystackProvider.verifyWebhook({}, JSON.stringify(CHARGE), creds);
    expect(n.ok).toBe(false);
  });

  it("verifyWebhook rejects when no signing secret is configured (fail closed)", () => {
    const raw = JSON.stringify(CHARGE);
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "whsec") }, raw, {});
    expect(n.ok).toBe(false);
  });

  it("verifyWebhook falls back to secretKey for signing", () => {
    const raw = JSON.stringify(CHARGE);
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "sk_test_123") }, raw, { secretKey: "sk_test_123" });
    expect(n.ok).toBe(true);
  });

  it("verifyWebhook ignores non-charge.success events", () => {
    const raw = JSON.stringify({ event: "charge.failed", data: CHARGE.data });
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "whsec") }, raw, creds);
    expect(n.ok).toBe(false);
  });

  it("verifyWebhook rejects malformed JSON", () => {
    const raw = "{not json";
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "whsec") }, raw, creds);
    expect(n.ok).toBe(false);
  });

  it("verifyWebhook rejects missing reference", () => {
    const raw = JSON.stringify({ event: "charge.success", data: { amount: 100 } });
    const n = paystackProvider.verifyWebhook({ "x-paystack-signature": hmac(raw, "whsec") }, raw, creds);
    expect(n.ok).toBe(false);
  });

  it("fetchStatus maps success", async () => {
    mockFetchOnce(async () => ({ ok: true, json: async () => ({ data: { status: "success", amount: 50000 } }) }));
    const s = await paystackProvider.fetchStatus("PAY-123", creds);
    expect(s).toEqual({ status: "success", amountCents: 50000 });
  });

  it("fetchStatus maps pending-ish states to pending", async () => {
    mockFetchOnce(async () => ({ ok: true, json: async () => ({ data: { status: "ongoing", amount: 100 } }) }));
    expect((await paystackProvider.fetchStatus("R", creds)).status).toBe("pending");
  });

  it("fetchStatus maps failed/abandoned to failed", async () => {
    mockFetchOnce(async () => ({ ok: true, json: async () => ({ data: { status: "abandoned", amount: 100 } }) }));
    expect((await paystackProvider.fetchStatus("R", creds)).status).toBe("failed");
  });

  it("fetchStatus throws on HTTP error", async () => {
    mockFetchOnce(async () => ({ ok: false, status: 404 }));
    await expect(paystackProvider.fetchStatus("R", creds)).rejects.toThrow("404");
  });

  it("testConnection ok with valid key", async () => {
    mockFetchOnce(async () => ({ ok: true }));
    expect((await paystackProvider.testConnection(creds)).ok).toBe(true);
  });

  it("testConnection fails without key / on HTTP error", async () => {
    expect((await paystackProvider.testConnection({})).ok).toBe(false);
    mockFetchOnce(async () => ({ ok: false, status: 401 }));
    const r = await paystackProvider.testConnection(creds);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
  });
});

// ─── Manual adapter ─────────────────────────────────────────────────────────
describe("manual adapter", () => {
  const creds = { bankName: "GTBank", accountNumber: "0123456789", accountName: "Acme Stores" };

  it("conforms to PaymentProvider", () => {
    const p: PaymentProvider = manualProvider;
    expect(p.id).toBe("manual");
    expect(typeof p.initiate).toBe("function");
  });

  it("initiate returns instructions, no authorizationUrl", async () => {
    const r = await manualProvider.initiate(
      { tenantId: "t1", amountCents: 125050, currency: "NGN", reference: "MAN-1", metadata: {}, customer: { phone: "1" } },
      creds,
    );
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("manual");
    expect(r.authorizationUrl).toBeUndefined();
    expect(r.instructions).toContain("NGN 1250.50");
    expect(r.instructions).toContain("GTBank");
    expect(r.instructions).toContain("0123456789");
    expect(r.instructions).toContain("Acme Stores");
    expect(r.instructions).toContain("MAN-1");
  });

  it("custom instructions override the template", () => {
    expect(renderManualInstructions({ ...creds, instructions: "Pay to POS agent" }, 100, "NGN", "R")).toBe("Pay to POS agent");
  });

  it("verifyWebhook always fails closed (receipt flow is separate)", () => {
    const n = manualProvider.verifyWebhook({}, "{}", creds);
    expect(n.ok).toBe(false);
    expect(n.metadata.reason).toContain("receipt");
  });

  it("fetchStatus is always pending (no API)", async () => {
    expect(await manualProvider.fetchStatus("R", creds)).toEqual({ status: "pending", amountCents: 0 });
  });

  it("testConnection requires accountNumber", async () => {
    expect((await manualProvider.testConnection(creds)).ok).toBe(true);
    expect((await manualProvider.testConnection({})).ok).toBe(false);
  });
});

// ─── Registry ───────────────────────────────────────────────────────────────
describe("registry", () => {
  beforeAll(() => {
    process.env.SECRETS_MASTER_KEY = TEST_MASTER_KEY;
  });
  beforeEach(() => {
    configRows = [];
    lastInsertValues = null;
  });

  it("has paystack + manual built in", () => {
    const ids = listProviderAdapters().map((a) => a.id);
    expect(ids).toContain("paystack");
    expect(ids).toContain("manual");
  });

  it("registerProvider adds a custom adapter", () => {
    const custom: PaymentProvider = {
      id: "test-prov", displayName: "Test",
      initiate: async () => ({ ok: false, reference: "", provider: "test-prov" }),
      verifyWebhook: () => ({ ok: false, reference: "", amountCents: 0, metadata: {} }),
      fetchStatus: async () => ({ status: "pending", amountCents: 0 }),
      testConnection: async () => ({ ok: true }),
    };
    registerProvider(custom);
    expect(getProviderAdapter("test-prov")).toBe(custom);
  });

  const row = (over: Partial<any>) => ({
    id: "r1", tenantId: "t1", provider: "paystack", publicKey: null,
    secretKey: "sk_legacy_plain", webhookSecret: null, callbackUrl: null,
    isActive: true, credentials: null, priority: 0, enabled: true,
    metadata: null, createdAt: new Date("2024-01-01"), updatedAt: new Date(),
    ...over,
  });

  it("resolves a legacy paystack config row (plaintext passthrough)", async () => {
    configRows = [row({})];
    const chain = await getProviderForTenant("t1");
    expect(chain).toHaveLength(1);
    expect(chain[0].provider.id).toBe("paystack");
    expect((chain[0].creds as any).secretKey).toBe("sk_legacy_plain");
    expect(chain[0].config.priority).toBe(0);
  });

  it("returns the full fallback chain ordered by priority DESC", async () => {
    configRows = [
      row({ id: "r1", provider: "manual", priority: 5, credentials: { bankName: "GTB" } }),
      row({ id: "r2", provider: "paystack", priority: 10 }),
    ];
    const chain = await getProviderForTenant("t1");
    expect(chain.map((e) => e.provider.id)).toEqual(["paystack", "manual"]);
    expect((chain[1].creds as any).bankName).toBe("GTB");
  });

  it("skips enabled=false rows", async () => {
    configRows = [row({ enabled: false }), row({ id: "r2", provider: "manual" })];
    const chain = await getProviderForTenant("t1");
    expect(chain.map((e) => e.provider.id)).toEqual(["manual"]);
  });

  it("skips rows with no registered adapter", async () => {
    configRows = [row({ provider: "stripe" }), row({ id: "r2" })];
    const chain = await getProviderForTenant("t1");
    expect(chain.map((e) => e.provider.id)).toEqual(["paystack"]);
  });

  it("upsert encrypts secrets at rest; resolution decrypts the round-trip", async () => {
    await upsertTenantProviderConfig({
      tenantId: "t1", provider: "paystack",
      creds: { secretKey: "sk_live_secret", webhookSecret: "wh_live", publicKey: "pk_x" },
      priority: 7,
    });
    expect(lastInsertValues.secretKey).toMatch(/^v1:/);
    expect(lastInsertValues.secretKey).not.toContain("sk_live_secret");
    expect(lastInsertValues.webhookSecret).toMatch(/^v1:/);
    expect(lastInsertValues.priority).toBe(7);
    // Simulate reading the stored row back through the registry.
    configRows = [row({ secretKey: lastInsertValues.secretKey, webhookSecret: lastInsertValues.webhookSecret, publicKey: "pk_x", priority: 7 })];
    const chain = await getProviderForTenant("t1");
    expect((chain[0].creds as any).secretKey).toBe("sk_live_secret");
    expect((chain[0].creds as any).webhookSecret).toBe("wh_live");
    expect((chain[0].creds as any).publicKey).toBe("pk_x");
  });

  it("upsert stores manual extras (non-secret) in credentials jsonb", async () => {
    await upsertTenantProviderConfig({
      tenantId: "t1", provider: "manual",
      creds: { bankName: "GTBank", accountNumber: "0123", accountName: "Acme" },
    });
    expect(lastInsertValues.credentials).toEqual({ bankName: "GTBank", accountNumber: "0123", accountName: "Acme" });
    expect(lastInsertValues.secretKey).toBeNull();
    configRows = [row({ id: "r9", provider: "manual", secretKey: null, credentials: lastInsertValues.credentials })];
    const chain = await getProviderForTenant("t1");
    expect((chain[0].creds as any).accountNumber).toBe("0123");
  });
});
