/**
 * W13 mandate service — provider orchestration + payment_mandates lifecycle.
 * Provider interactions are stubbed via __setMandateProvidersForTests (the
 * mandate-capable provider contract is owned by the payments wave); the db is
 * the tradeCredit fakeDb extended with payment_mandates semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeDb } from "../tradeCredit/fakeDb";
import {
  __setMandateProvidersForTests,
  chargeOnMandate,
  confirmMandateTx,
  createMandateForTenant,
  getActiveMandateForTenantTx,
  revokeMandate,
} from "./mandates";

function makeProvider(over: Record<string, any> = {}) {
  return {
    provider: {
      id: "paystack",
      displayName: "Paystack",
      supportsMandates: true,
      initiate: vi.fn(),
      verifyWebhook: vi.fn(),
      fetchStatus: vi.fn(),
      testConnection: vi.fn(),
      createMandate: vi.fn(async () => ({
        ok: true,
        mandateRef: "AUTH_abc123",
        authorizationUrl: "https://pay.example/auth",
        provider: "paystack",
      })),
      chargeMandate: vi.fn(async (ctx: any) => ({
        ok: true,
        reference: ctx.reference,
        status: "success" as const,
        provider: "paystack",
      })),
      revokeMandate: vi.fn(async () => ({ ok: true })),
      ...over,
    },
    creds: { secretKey: "sk" },
    config: { priority: 1 },
  };
}

const TENANT = "buyer-1";

afterEach(() => {
  __setMandateProvidersForTests(null);
});

describe("createMandateForTenant", () => {
  it("persists a pending mandate via the first mandate-capable provider", async () => {
    const { db, store } = makeFakeDb();
    const entry = makeProvider();
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await createMandateForTenant(db, { tenantId: TENANT, customerRef: "acct-1" });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("pending");
    expect(res.mandateRef).toBe("AUTH_abc123");
    expect(res.authorizationUrl).toBe("https://pay.example/auth");
    expect(store.mandates).toHaveLength(1);
    expect(store.mandates[0]).toMatchObject({ tenantId: TENANT, provider: "paystack", status: "pending" });
  });

  it("returns ok:false without persisting when the provider refuses", async () => {
    const { db, store } = makeFakeDb();
    const entry = makeProvider({
      createMandate: vi.fn(async () => ({ ok: false, provider: "paystack", error: "bank_declined" })),
    });
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await createMandateForTenant(db, { tenantId: TENANT });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bank_declined");
    expect(store.mandates).toHaveLength(0);
  });

  it("dev escape: issues an active fake mandate outside prod when no provider is capable", async () => {
    const { db, store } = makeFakeDb();
    __setMandateProvidersForTests(async () => []);
    const res = await createMandateForTenant(db, { tenantId: TENANT });
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("fake");
    expect(res.status).toBe("active");
    expect(store.mandates[0].mandateRef).toMatch(/^fake-/);
  });

  it("never throws when the provider registry blows up", async () => {
    const { db } = makeFakeDb();
    __setMandateProvidersForTests(async () => {
      throw new Error("registry down");
    });
    // resolveProviders throws → caught inside createMandateForTenant
    const res = await createMandateForTenant(db, { tenantId: TENANT });
    expect(res.ok).toBe(false);
  });
});

describe("confirmMandateTx", () => {
  it("flips pending → active claim-first; a second confirm finds nothing", async () => {
    const { db, store } = makeFakeDb();
    const entry = makeProvider();
    __setMandateProvidersForTests(async () => [entry] as any);
    const created = await createMandateForTenant(db, { tenantId: TENANT });
    const confirmed = await confirmMandateTx(db, { tenantId: TENANT, mandateId: created.mandateId! });
    expect(confirmed?.status).toBe("active");
    const again = await confirmMandateTx(db, { tenantId: TENANT, mandateId: created.mandateId! });
    expect(again).toBeNull();
  });

  it("refuses cross-tenant confirmation", async () => {
    const { db } = makeFakeDb();
    const entry = makeProvider();
    __setMandateProvidersForTests(async () => [entry] as any);
    const created = await createMandateForTenant(db, { tenantId: TENANT });
    const res = await confirmMandateTx(db, { tenantId: "other-tenant", mandateId: created.mandateId! });
    expect(res).toBeNull();
    expect((await getActiveMandateForTenantTx(db, TENANT))).toBeNull();
  });
});

describe("chargeOnMandate", () => {
  async function activeMandate(seedStatus = "active") {
    const { db, store } = makeFakeDb({
      mandates: [
        {
          id: "m-1",
          tenantId: TENANT,
          provider: "paystack",
          mandateRef: "AUTH_abc123",
          customerRef: null,
          status: seedStatus,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    return { db, store };
  }

  it("charges an active mandate through its provider", async () => {
    const { db } = await activeMandate();
    const entry = makeProvider();
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await chargeOnMandate(db, {
      tenantId: TENANT,
      mandateId: "m-1",
      amountCents: 5000,
      reference: "cr-a-20250101-000001",
      metadata: { type: "credit_repayment", accountId: "a" },
    });
    expect(res).toMatchObject({ ok: true, status: "success", reference: "cr-a-20250101-000001" });
    expect(entry.provider.chargeMandate).toHaveBeenCalledWith(
      expect.objectContaining({ mandateRef: "AUTH_abc123", amountCents: 5000 }),
      expect.anything(),
    );
  });

  it("fails closed on a non-active mandate", async () => {
    const { db } = await activeMandate("pending");
    const res = await chargeOnMandate(db, { tenantId: TENANT, mandateId: "m-1", amountCents: 100, reference: "r" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("mandate_not_active:pending");
  });

  it("fails closed on unknown or cross-tenant mandates", async () => {
    const { db } = await activeMandate();
    expect((await chargeOnMandate(db, { tenantId: TENANT, mandateId: "nope", amountCents: 1, reference: "r" })).error)
      .toBe("mandate_not_found");
    expect((await chargeOnMandate(db, { tenantId: "other", mandateId: "m-1", amountCents: 1, reference: "r" })).error)
      .toBe("mandate_not_found");
  });

  it("propagates provider charge failure without throwing", async () => {
    const { db } = await activeMandate();
    const entry = makeProvider({
      chargeMandate: vi.fn(async () => ({ ok: false, reference: "r", status: "failed" as const, provider: "paystack", error: "insufficient_funds" })),
    });
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await chargeOnMandate(db, { tenantId: TENANT, mandateId: "m-1", amountCents: 100, reference: "r" });
    expect(res).toMatchObject({ ok: false, status: "failed", error: "insufficient_funds" });
  });

  it("fails closed when the mandate's provider is not mandate-capable anymore", async () => {
    const { db } = await activeMandate();
    __setMandateProvidersForTests(async () => []);
    const res = await chargeOnMandate(db, { tenantId: TENANT, mandateId: "m-1", amountCents: 100, reference: "r" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("provider_not_mandate_capable");
  });

  it("dev fake mandates charge locally (success, no provider I/O)", async () => {
    const { db } = makeFakeDb({
      mandates: [
        {
          id: "m-f", tenantId: TENANT, provider: "fake", mandateRef: "fake-1",
          customerRef: null, status: "active", metadata: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
    const res = await chargeOnMandate(db, { tenantId: TENANT, mandateId: "m-f", amountCents: 100, reference: "r" });
    expect(res).toMatchObject({ ok: true, status: "success", provider: "fake" });
  });

  it("rejects invalid amounts", async () => {
    const { db } = await activeMandate();
    const res = await chargeOnMandate(db, { tenantId: TENANT, mandateId: "m-1", amountCents: 0, reference: "r" });
    expect(res.error).toBe("invalid_amount");
  });
});

describe("revokeMandate", () => {
  it("revokes at the provider and flips local status claim-first", async () => {
    const { db, store } = makeFakeDb({
      mandates: [
        {
          id: "m-1", tenantId: TENANT, provider: "paystack", mandateRef: "AUTH_abc123",
          customerRef: null, status: "active", metadata: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
    const entry = makeProvider();
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await revokeMandate(db, { tenantId: TENANT, mandateId: "m-1" });
    expect(res.ok).toBe(true);
    expect(entry.provider.revokeMandate).toHaveBeenCalledWith("AUTH_abc123", expect.anything());
    expect(store.mandates[0].status).toBe("revoked");
    // Idempotent
    expect((await revokeMandate(db, { tenantId: TENANT, mandateId: "m-1" })).ok).toBe(true);
  });

  it("fails closed for unknown / cross-tenant mandates", async () => {
    const { db } = makeFakeDb();
    expect((await revokeMandate(db, { tenantId: TENANT, mandateId: "nope" })).ok).toBe(false);
  });
});
