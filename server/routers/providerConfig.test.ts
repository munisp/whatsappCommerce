/**
 * providerConfig.test.ts — wave-11 tenant provider settings procs:
 *  - listProviderAdapters / getTenantProviders (masking, priority ordering)
 *  - configureProvider: authZ, unknown-provider + custom-validation errors,
 *    encrypt-on-write via upsertTenantProviderConfig, masked-sentinel keep
 *  - setProviderPriority / toggleProvider: column writes + NOT_FOUND
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

// ── DB fake ──────────────────────────────────────────────────────────────────
interface Row {
  id: string;
  tenantId: string;
  provider: string;
  publicKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  callbackUrl: string | null;
  isActive: boolean;
  enabled: boolean;
  priority: number;
  credentials: Record<string, unknown> | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const store = vi.hoisted(() => ({ rows: [] as any[] }));

function makeDb() {
  const thenable = (rows: any[]) => {
    const self: any = {};
    self.orderBy = () => thenable([...rows].sort((a, b) => b.priority - a.priority));
    self.then = (res: (v: any[]) => void) => {
      res(rows);
      return self;
    };
    self.catch = () => self;
    return self;
  };
  return {
    select: () => ({
      from: () => ({
        where: () => thenable(store.rows),
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: () => {
          const i = store.rows.findIndex((r) => r.tenantId === v.tenantId && r.provider === v.provider);
          if (i >= 0) store.rows[i] = { ...store.rows[i], ...v };
          else store.rows.push(v);
          return Promise.resolve();
        },
        then: (res: () => void) => {
          store.rows.push(v);
          res();
          return Promise.resolve();
        },
      }),
    }),
    update: () => ({
      set: (s: any) => ({
        where: () => {
          const row = store.rows[0];
          if (row) Object.assign(row, s);
          return Promise.resolve();
        },
      }),
    }),
  };
}

vi.mock("../db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => makeDb()) };
});

function makeCtx(role: "admin" | "user", tenantId?: string): TrpcContext {
  return {
    user: {
      id: 1, openId: "test-user", email: "t@e.c", name: "T", loginMethod: "manus",
      role, tenantId: tenantId ?? null,
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const seedRow = (over: Partial<Row> = {}): Row => ({
  id: "r1", tenantId: "t1", provider: "paystack",
  publicKey: "pk_live_x", secretKey: "v1:enc:tag:ct", webhookSecret: null,
  callbackUrl: null, isActive: true, enabled: true, priority: 10,
  credentials: { instructions: "Pay bank" }, metadata: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

beforeEach(() => {
  store.rows = [];
});

describe("paymentGateway.listProviderAdapters", () => {
  it("returns the registry catalog (paystack + manual built-ins)", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    const adapters = await caller.paymentGateway.listProviderAdapters();
    const ids = adapters.map((a) => a.id);
    expect(ids).toContain("paystack");
    expect(ids).toContain("manual");
  });
});

describe("paymentGateway.getTenantProviders", () => {
  it("masks secrets and maps enabled/priority/instructions from the row", async () => {
    store.rows = [seedRow(), seedRow({ id: "r2", provider: "manual", secretKey: null, priority: 20, enabled: false })];
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    const out = await caller.paymentGateway.getTenantProviders({ tenantId: "t1" });
    expect(out.providers).toHaveLength(2);
    const paystack = out.providers.find((p) => p.provider === "paystack")!;
    expect(paystack.secretKey).toBe("••••••••");
    expect(paystack.secretKey).not.toContain("v1:");
    expect(paystack.priority).toBe(10);
    expect(paystack.instructions).toBe("Pay bank");
    const manual = out.providers.find((p) => p.provider === "manual")!;
    expect(manual.secretKey).toBeNull();
    expect(manual.enabled).toBe(false);
    // Priority DESC ordering for the fallback-chain preview.
    expect(out.providers[0].provider).toBe("manual");
  });

  it("rejects cross-tenant reads", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    await expect(caller.paymentGateway.getTenantProviders({ tenantId: "t2" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("paymentGateway.configureProvider", () => {
  it("rejects unknown provider ids with a custom-gateway hint", async () => {
    const caller = appRouter.createCaller(makeCtx("admin"));
    await expect(
      caller.paymentGateway.configureProvider({ tenantId: "t1", provider: "paypal" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("custom gateway requires instructions or a JSON config", async () => {
    const caller = appRouter.createCaller(makeCtx("admin"));
    await expect(
      caller.paymentGateway.configureProvider({ tenantId: "t1", provider: "custom" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // With instructions → ok
    await expect(
      caller.paymentGateway.configureProvider({ tenantId: "t1", provider: "custom", instructions: "Pay to X" }),
    ).resolves.toEqual({ ok: true });
    const row = store.rows.find((r) => r.provider === "custom")!;
    expect(row.credentials.instructions).toBe("Pay to X");
  });

  it("encrypts the secret key on write (never stores plaintext)", async () => {
    const caller = appRouter.createCaller(makeCtx("admin"));
    await caller.paymentGateway.configureProvider({ tenantId: "t1", provider: "paystack", secretKey: "sk_live_secret" });
    const row = store.rows.find((r) => r.provider === "paystack")!;
    expect(row.secretKey).toMatch(/^v1:/);
    expect(row.secretKey).not.toContain("sk_live_secret");
  });

  it("masked sentinel keeps the previously stored secret", async () => {
    const { encryptSecret } = await import("../services/crypto/secrets");
    store.rows = [seedRow({ secretKey: encryptSecret("sk_live_original") })];
    const { decryptSecret } = await import("../services/crypto/secrets");
    const before = decryptSecret(store.rows[0].secretKey);
    const caller = appRouter.createCaller(makeCtx("admin"));
    await caller.paymentGateway.configureProvider({
      tenantId: "t1", provider: "paystack", secretKey: "••••••••", priority: 42,
    });
    const row = store.rows.find((r) => r.provider === "paystack")!;
    expect(decryptSecret(row.secretKey)).toBe(before);
    expect(row.priority).toBe(42);
  });

  it("non-admin cannot write another tenant's provider config", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    await expect(
      caller.paymentGateway.configureProvider({ tenantId: "t2", provider: "paystack", secretKey: "sk" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("paymentGateway.setProviderPriority / toggleProvider", () => {
  it("writes the priority column", async () => {
    store.rows = [seedRow()];
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    await expect(
      caller.paymentGateway.setProviderPriority({ tenantId: "t1", provider: "paystack", priority: 99 }),
    ).resolves.toEqual({ ok: true });
    expect(store.rows[0].priority).toBe(99);
  });

  it("writes the enabled column", async () => {
    store.rows = [seedRow()];
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    await caller.paymentGateway.toggleProvider({ tenantId: "t1", provider: "paystack", enabled: false });
    expect(store.rows[0].enabled).toBe(false);
  });

  it("NOT_FOUND when the provider is not configured", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    await expect(
      caller.paymentGateway.setProviderPriority({ tenantId: "t1", provider: "stripe", priority: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.paymentGateway.toggleProvider({ tenantId: "t1", provider: "stripe", enabled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("paymentGateway.testProvider", () => {
  it("manual provider with instructions probes OK", async () => {
    store.rows = [seedRow({ provider: "manual", secretKey: null, credentials: { instructions: "Pay to GTB" } })];
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    const r = await caller.paymentGateway.testProvider({ tenantId: "t1", provider: "manual" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("instructions");
  });

  it("unconfigured provider reports a clear failure (never throws)", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "t1"));
    const r = await caller.paymentGateway.testProvider({ tenantId: "t1", provider: "stripe" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not configured");
  });
});
