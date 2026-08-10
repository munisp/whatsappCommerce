/**
 * paymentsSurfaces.test.ts — wave-11 P3 surface rewires (registry-routed):
 *
 *  - creditRepayLink initiates via the registry fallback chain (NOT a direct
 *    Paystack call): fallback serves, serving provider recorded on the intent
 *  - metadata conventions UNCHANGED (exact credit_repayment metadata passed
 *    to the provider + stored on the intent — guards the paymentConfirm
 *    hooks that pattern-match on it)
 *  - manual/custom provider → instructions instead of paymentUrl
 *  - all providers fail → graceful CreditRepayError; empty chain →
 *    not-configured error
 *  - PO pay-now message composition is shape-driven (url vs instructions)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTableName, SQL } from "drizzle-orm";
import { ENV } from "./_core/env";
import type { PaymentProvider, PaymentInitiateCtx } from "./services/payments/providers/types";

// ── Mocks ────────────────────────────────────────────────────────────────────
const registryMock = vi.hoisted(() => ({ getProviderForTenant: vi.fn(), getProviderAdapter: vi.fn() }));
vi.mock("./services/payments/providers/registry", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getProviderForTenant: registryMock.getProviderForTenant,
    getProviderAdapter: registryMock.getProviderAdapter,
  };
});

const recordUsageSpy = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("./services/metering", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, recordUsage: recordUsageSpy };
});

import { createRepaymentLink, CreditRepayError } from "./services/creditRepayLink";

// ── Fake db (same shape as creditRepay.test.ts) ──────────────────────────────
const tname = (t: unknown) => {
  try {
    return getTableName(t as any);
  } catch {
    return "";
  }
};
function thenable<T>(rows: T[]) {
  const self: any = {};
  self.returning = async () => rows;
  self.then = (res: (v: T[]) => void) => {
    res(rows);
    return self;
  };
  self.catch = () => self;
  self.finally = (cb: () => void) => {
    cb();
    return self;
  };
  return self;
}
function sqlInfo(q: any): { text: string } {
  const chunks = (q as any)?.queryChunks ?? [];
  let text = "";
  for (const c of chunks) {
    if (Array.isArray(c?.value)) text += c.value.join("");
    else if (c instanceof SQL) text += sqlInfo(c).text;
    else text += "?";
  }
  return { text };
}
const ACCOUNT = { id: "acct-1", buyer_tenant_id: "buyer-t", outstanding_cents: 100_000, currency: "NGN" };
function makeLinkDb(accountRows: Array<Record<string, unknown>>) {
  const intentInserts: any[] = [];
  const intentUpdates: any[] = [];
  const db: any = {
    execute: async (q: any) => (sqlInfo(q).text.includes("credit_accounts") ? accountRows : []),
    insert: (table: any) => ({
      values: (v: any) => {
        if (tname(table) === "payment_intents") intentInserts.push(v);
        return thenable([]);
      },
    }),
    update: (table: any) => ({
      set: (s: any) => ({
        where: () => {
          if (tname(table) === "payment_intents") intentUpdates.push(s);
          return thenable([]);
        },
      }),
    }),
    intentInserts,
    intentUpdates,
  };
  return db;
}

// ── Fake providers ───────────────────────────────────────────────────────────
function provider(id: string, impl: (ctx: PaymentInitiateCtx) => any): { p: PaymentProvider; seen: PaymentInitiateCtx[] } {
  const seen: PaymentInitiateCtx[] = [];
  const p: PaymentProvider = {
    id,
    displayName: id,
    async initiate(ctx) {
      seen.push(ctx);
      return impl(ctx);
    },
    verifyWebhook: () => ({ ok: false, reference: "", amountCents: 0, metadata: {} }),
    fetchStatus: async () => ({ status: "pending", amountCents: 0 }),
    testConnection: async () => ({ ok: true }),
  };
  return { p, seen };
}
const entryOf = (pr: { p: PaymentProvider }, priority = 0) => ({ provider: pr.p, creds: { secretKey: "sk" }, config: { priority } });

beforeEach(() => {
  vi.clearAllMocks();
  ENV.paystackSecretKey = "";
  ENV.flwSecretKey = "";
});
afterEach(() => vi.unstubAllGlobals());

const INPUT = { buyerTenantId: "buyer-t", accountId: "acct-1", poId: "po-9", customerPhone: "+2348000000000" };

describe("createRepaymentLink via registry fallback", () => {
  it("serves via fallback provider when the primary throws; provider recorded on intent", async () => {
    const failing = provider("paystack", () => {
      throw new Error("paystack 502");
    });
    const serving = provider("flutterwave", (ctx) => ({
      ok: true, reference: ctx.reference, provider: "flutterwave",
      authorizationUrl: "https://fw.example/checkout/1",
    }));
    registryMock.getProviderForTenant.mockResolvedValue([entryOf(failing, 10), entryOf(serving, 5)]);
    const db = makeLinkDb([ACCOUNT]);
    const res = await createRepaymentLink(db, INPUT);
    expect(res.paymentUrl).toBe("https://fw.example/checkout/1");
    expect(res.provider).toBe("flutterwave");
    // Serving provider recorded on the intent record (enum column + metadata).
    const upd = db.intentUpdates.at(-1);
    expect(upd.provider).toBe("flutterwave");
    expect(upd.metadata.servedProvider).toBe("flutterwave");
  });

  it("metadata conventions UNCHANGED — exact credit_repayment metadata to provider + intent", async () => {
    const serving = provider("paystack", (ctx) => ({
      ok: true, reference: ctx.reference, provider: "paystack", authorizationUrl: "https://pay.example/x",
    }));
    registryMock.getProviderForTenant.mockResolvedValue([entryOf(serving)]);
    const db = makeLinkDb([ACCOUNT]);
    const res = await createRepaymentLink(db, INPUT);
    // Provider-bound metadata (what the webhook resolves back with).
    expect(serving.seen[0].metadata).toEqual({
      payment_intent_id: res.paymentIntentId,
      tenant_id: "buyer-t",
      kind: "credit_repayment",
      accountId: "acct-1",
      poId: "po-9",
    });
    // Intent-row metadata the post-confirm hook keys on.
    expect(db.intentInserts[0].metadata).toEqual({
      kind: "credit_repayment",
      accountId: "acct-1",
      poId: "po-9",
      tenantId: "buyer-t",
      customerPhone: "+2348000000000",
    });
    expect(db.intentInserts[0].provider).toBe("paystack");
    expect(serving.seen[0].amountCents).toBe(100_000);
    expect(serving.seen[0].reference).toBe(res.reference);
  });

  it("manual provider → instructions instead of paymentUrl; intent buckets provider as 'manual'", async () => {
    const manual = provider("manual", (ctx) => ({
      ok: true, reference: ctx.reference, provider: "manual", instructions: "Pay to GTB 0123456789",
    }));
    registryMock.getProviderForTenant.mockResolvedValue([entryOf(manual)]);
    const db = makeLinkDb([ACCOUNT]);
    const res = await createRepaymentLink(db, INPUT);
    expect(res.paymentUrl).toBeNull();
    expect(res.instructions).toBe("Pay to GTB 0123456789");
    expect(res.provider).toBe("manual");
    expect(db.intentUpdates.at(-1).metadata.instructions).toBe("Pay to GTB 0123456789");
  });

  it("all providers fail → graceful CreditRepayError (paystack-init-failed), intent marked failed", async () => {
    const a = provider("paystack", () => ({ ok: false, reference: "x", provider: "paystack" }));
    const b = provider("flutterwave", () => {
      throw new Error("down");
    });
    registryMock.getProviderForTenant.mockResolvedValue([entryOf(a, 10), entryOf(b, 5)]);
    const db = makeLinkDb([ACCOUNT]);
    const err = await createRepaymentLink(db, INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(CreditRepayError);
    expect(err.code).toBe("paystack-init-failed");
    expect(db.intentUpdates.some((u) => u.status === "failed")).toBe(true);
  });

  it("no provider configured (empty chain, no env) → paystack-not-configured", async () => {
    registryMock.getProviderForTenant.mockResolvedValue([]);
    registryMock.getProviderAdapter.mockReturnValue(undefined);
    const db = makeLinkDb([ACCOUNT]);
    const err = await createRepaymentLink(db, INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(CreditRepayError);
    expect(err.code).toBe("paystack-not-configured");
  });

  it("empty tenant chain uses the env-default paystack adapter (legacy tenants)", async () => {
    ENV.paystackSecretKey = "sk_env";
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: any, init: any) => {
        calls.push({ url: String(u), body: JSON.parse(init.body) });
        return {
          ok: true, status: 200,
          json: async () => ({ status: true, data: { authorization_url: "https://pay.example/env" } }),
          text: async () => "",
        } as unknown as Response;
      }),
    );
    registryMock.getProviderForTenant.mockResolvedValue([]);
    // envDefaultChain resolves the adapter from the REAL registry (paystack
    // self-registers at module load — importOriginal above kept it real).
    const { getProviderAdapter: realGet } = await vi.importActual<any>("./services/payments/providers/registry");
    registryMock.getProviderAdapter.mockImplementation((id: string) => realGet(id));
    const db = makeLinkDb([ACCOUNT]);
    const res = await createRepaymentLink(db, INPUT);
    expect(res.paymentUrl).toBe("https://pay.example/env");
    expect(res.provider).toBe("paystack");
    expect(calls[0].url).toContain("api.paystack.co/transaction/initialize");
    expect(calls[0].body.metadata).toMatchObject({ kind: "credit_repayment", accountId: "acct-1", poId: "po-9" });
  });
});

// ── PO pay-now message composition (shape-driven) ────────────────────────────
describe("PO pay-now shape-driven message", () => {
  it("createPoPaymentLink maps payment.initiate's normalized result", async () => {
    // Stub the appRouter dynamic import path by exercising the mapping via a
    // caller double: payment.initiate returns {paymentUrl, instructions, provider}.
    const { createPoPaymentLink } = await import("./services/procurement/poFlow");
    const routers = await import("./routers");
    const original = routers.appRouter.createCaller;
    const fakeCaller = {
      payment: {
        initiate: vi.fn(async () => ({ paymentUrl: null, instructions: "Pay to bank X", provider: "manual" })),
      },
    };
    (routers.appRouter as any).createCaller = () => fakeCaller;
    try {
      const po: any = { id: "po-1", poNumber: "PO-1", supplierTenantId: "sup-t", subtotalCents: 5000, buyerPhone: "+2341" };
      const out = await createPoPaymentLink({} as any, po);
      expect(out).toEqual({ paymentUrl: null, instructions: "Pay to bank X", provider: "manual" });
      expect(fakeCaller.payment.initiate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "sup-t",
          orderId: "po-1",
          provider: "paystack", // preference only — registry resolves the chain
          metadata: { type: "po_payment", poId: "po-1", poNumber: "PO-1" },
        }),
      );
    } finally {
      (routers.appRouter as any).createCaller = original;
    }
  });
});
