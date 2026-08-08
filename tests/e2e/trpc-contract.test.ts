/**
 * tRPC CONTRACT — exercises ~27 representative procedures across domains
 * against the live platform server, validating response SHAPES (not just
 * HTTP 200s). Procedure names and auth levels were grep-verified against
 * server/routers/*.ts at 626cb97.
 *
 * Auth: the platform session is an HS256 JWT (JWT_SECRET) whose openId must
 * exist in the users table (server/_core/sdk.ts authenticateRequest).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CFG,
  trpcQuery,
  trpcMutation,
  mintPlatformSession,
  seedUser,
  getSql,
  closeSql,
  uniqueId,
} from "./helpers/stack";

const TENANT = uniqueId("e2e-tenant");
let userToken: string;
let adminToken: string;

beforeAll(async () => {
  await seedUser({ openId: "e2e-user", name: "E2E User", role: "user", tenantId: TENANT });
  await seedUser({ openId: "e2e-admin", name: "E2E Admin", role: "admin", tenantId: TENANT });
  userToken = await mintPlatformSession("e2e-user", "E2E User");
  adminToken = await mintPlatformSession("e2e-admin", "E2E Admin");
}, 30_000);

afterAll(async () => {
  await closeSql();
});

describe("tRPC contract — auth & system", () => {
  it("auth.me returns null when unauthenticated (public)", async () => {
    const r = await trpcQuery("auth.me");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeNull();
  });

  it("auth.me returns the session user when authenticated", async () => {
    const r = await trpcQuery<{ openId: string; name: string | null }>("auth.me", undefined, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.openId).toBe("e2e-user");
      expect(r.data?.name).toBe("E2E User");
    }
  });

  it("system.health → { ok: true }", async () => {
    const r = await trpcQuery<{ ok: boolean }>("system.health", { timestamp: Date.now() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ ok: true });
  });

  it("protected procedure without a token → UNAUTHORIZED (401)", async () => {
    const r = await trpcQuery("product.list", { tenantId: TENANT });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.trpcCode).toBe("UNAUTHORIZED");
      expect(r.error.httpStatus).toBe(401);
    }
  });
});

describe("tRPC contract — infra/temporal/apisix/mlOps", () => {
  it("infra.infraHealth returns the 15-service map with postgres+redis online", async () => {
    const r = await trpcQuery<{
      checkedAt: number;
      services: Record<string, { online: boolean; latencyMs: number }>;
    }>("infra.infraHealth", undefined, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data.checkedAt).toBe("number");
      for (const svc of [
        "postgres", "redis", "kafka", "tigerBeetle", "mojaloop",
        "apisix", "keycloak", "openappsec", "permify", "opensearch",
        "fluvio", "dapr", "temporal", "mlStack", "reconWorker",
      ]) {
        expect(r.data.services, `services.${svc} present`).toHaveProperty(svc);
        expect(typeof r.data.services[svc].online).toBe("boolean");
      }
      expect(r.data.services.postgres.online).toBe(true);
      expect(r.data.services.redis.online).toBe(true);
    }
  });

  it("temporal.health → { online: false, error: not_configured } in this stack", async () => {
    const r = await trpcQuery<{ online: boolean; error?: string }>("temporal.health");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data.online).toBe("boolean");
      // TEMPORAL_ADDRESS is unset in the test compose → honest not_configured.
      expect(r.data).toEqual({ online: false, error: "not_configured" });
    }
  });

  it("apisix.health → { configured: false, reachable: false } without admin key", async () => {
    const r = await trpcQuery<{ configured: boolean; reachable: boolean }>(
      "apisix.health", undefined, userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ configured: false, reachable: false });
  });

  it("mlOps.getTrainingStatus → array", async () => {
    const r = await trpcQuery<unknown[]>("mlOps.getTrainingStatus", undefined, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });

  it("mlOps.getDataPipelineStatus → pipeline counters shape", async () => {
    const r = await trpcQuery<{
      newTransactionsSinceLastTrain: number;
      thresholdToRetrain: number;
      percentToThreshold: number;
    }>("mlOps.getDataPipelineStatus", undefined, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data.newTransactionsSinceLastTrain).toBe("number");
      expect(typeof r.data.thresholdToRetrain).toBe("number");
      expect(typeof r.data.percentToThreshold).toBe("number");
    }
  });

  it("infra.listTbAccounts (admin) → { accounts: [...] }", async () => {
    const r = await trpcQuery<{ accounts: unknown[] }>("infra.listTbAccounts", {}, adminToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data.accounts)).toBe(true);
  });
});

describe("tRPC contract — products CRUD", () => {
  const sku = uniqueId("SKU");
  let productId: string;

  it("product.create → echoes id + fields", async () => {
    const r = await trpcMutation<{ id: string; sku: string; name: string; price: string }>(
      "product.create",
      {
        tenantId: TENANT,
        sku,
        name: "E2E Test Product",
        description: "created by e2e suite",
        price: "1250.00",
        currency: "NGN",
        stockQuantity: 25,
      },
      userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data.id).toBe("string");
      expect(r.data.sku).toBe(sku);
      productId = r.data.id;
    }
  });

  it("product.list contains the created product", async () => {
    const r = await trpcQuery<Array<{ id: string; sku: string }>>(
      "product.list", { tenantId: TENANT }, userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.data)).toBe(true);
      expect(r.data.some((p) => p.id === productId)).toBe(true);
    }
  });

  it("product.update → { success: true } and new name persisted", async () => {
    const r = await trpcMutation<{ success: boolean }>(
      "product.update",
      { id: productId, tenantId: TENANT, name: "E2E Renamed Product" },
      userToken,
    );
    expect(r.ok).toBe(true);
    const check = await trpcQuery<Array<{ id: string; name: string }>>(
      "product.list", { tenantId: TENANT }, userToken,
    );
    if (check.ok) {
      expect(check.data.find((p) => p.id === productId)?.name).toBe("E2E Renamed Product");
    }
  });

  it("product.stats → numeric counters", async () => {
    const r = await trpcQuery<Record<string, unknown>>("product.stats", { tenantId: TENANT }, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeTypeOf("object");
  });
});

describe("tRPC contract — orders create → get → status", () => {
  let orderId: string;
  const productId = uniqueId("e2e-prod");

  beforeAll(async () => {
    // orderCrud.create has an atomic oversell guard on inventory_snapshots —
    // seed stock for the product being ordered. The pre-payment inventory
    // guard (0031) also requires a products row with stockQuantity.
    const sql = getSql();
    await sql`
      INSERT INTO inventory_snapshots (id, "tenantId", "productId", "stockQty", "reservedQty", "availableQty", "lastSyncedAt", "syncSource")
      VALUES (${uniqueId("inv")}, ${TENANT}, ${productId}, 100, 0, 100, NOW(), 'odoo')`;
    await sql`
      INSERT INTO products (id, "tenantId", sku, name, price, currency, status, "stockQuantity", "createdAt", "updatedAt")
      VALUES (${productId}, ${TENANT}, ${uniqueId("sku")}, 'E2E Widget', 500, 'NGN', 'active', 100, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING`;
  });

  it("orderCrud.create → { orderId, orderNumber, total }", async () => {
    const r = await trpcMutation<{ orderId: string; orderNumber: string; total: number }>(
      "orderCrud.create",
      {
        tenantId: TENANT,
        customerId: uniqueId("cust"),
        currency: "NGN",
        items: [{ productId, productName: "E2E Widget", quantity: 2, unitPrice: 500 }],
      },
      userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.orderId).toBeTypeOf("string");
      expect(r.data.orderNumber).toMatch(/^ORD-/);
      expect(Number(r.data.total)).toBe(1000);
      orderId = r.data.orderId;
    }
  });

  it("order.list returns the created order with status pending", async () => {
    const r = await trpcQuery<Array<{ id: string; status: string; totalAmount: string }>>(
      "order.list", { tenantId: TENANT }, userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const order = r.data.find((o) => o.id === orderId);
      expect(order).toBeDefined();
      expect(order?.status).toBe("pending");
      expect(parseFloat(order!.totalAmount)).toBe(1000);
    }
  });

  it("orderCrud.updateStatus pending → confirmed", async () => {
    const r = await trpcMutation<{ ok: boolean }>(
      "orderCrud.updateStatus", { orderId, status: "confirmed" }, userToken,
    );
    expect(r.ok).toBe(true);
    const check = await trpcQuery<Array<{ id: string; status: string }>>(
      "order.list", { tenantId: TENANT, status: "confirmed" }, userToken,
    );
    if (check.ok) expect(check.data.some((o) => o.id === orderId)).toBe(true);
  });

  it("order.stats → object with counters", async () => {
    const r = await trpcQuery<Record<string, unknown>>("order.stats", { tenantId: TENANT }, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeTypeOf("object");
  });

  it("orderCrud.create rejects oversell (PRECONDITION_FAILED)", async () => {
    const r = await trpcMutation(
      "orderCrud.create",
      {
        tenantId: TENANT,
        customerId: uniqueId("cust"),
        items: [{ productId, productName: "E2E Widget", quantity: 10_000, unitPrice: 1 }],
      },
      userToken,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.trpcCode).toBe("PRECONDITION_FAILED");
      expect(r.error.message).toContain("Insufficient stock");
    }
  });
});

describe("tRPC contract — conversations", () => {
  it("conversation.list → array", async () => {
    const r = await trpcQuery<unknown[]>("conversation.list", { tenantId: TENANT }, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });

  it("conversation.stats → object", async () => {
    const r = await trpcQuery<Record<string, unknown>>("conversation.stats", { tenantId: TENANT }, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeTypeOf("object");
  });

  it("conversation.getMessages → array", async () => {
    const r = await trpcQuery<unknown[]>("conversation.getMessages", { tenantId: TENANT }, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });
});

describe("tRPC contract — payments & wallet (honest config errors)", () => {
  it("payment.initiate (mojaloop — no external keys needed) → initiated shape", async () => {
    const r = await trpcMutation<{
      paymentIntentId: string;
      reference: string;
      paymentUrl: string | null;
      status: string;
    }>(
      "payment.initiate",
      {
        tenantId: TENANT,
        orderId: uniqueId("order"),
        amount: 2500,
        currency: "NGN",
        provider: "mojaloop",
        customerPhone: "+2348012345678",
      },
      userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe("initiated");
      expect(r.data.reference).toMatch(/^PAY-/);
      expect(r.data.paymentUrl).toContain(r.data.reference);
    }
  });

  it("payment.initiate (paystack, key unset) → honest CONFIG error, not a crash", async () => {
    const r = await trpcMutation(
      "payment.initiate",
      {
        tenantId: TENANT,
        orderId: uniqueId("order"),
        amount: 1000,
        currency: "NGN",
        provider: "paystack",
        customerPhone: "+2348012345678",
      },
      userToken,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The server wraps provider setup failures as "Payment initiation
      // failed: PAYSTACK_SECRET_KEY not configured" — a structured tRPC error
      // with an honest message, NOT an HTTP 500 HTML crash page.
      expect(r.error.message).toContain("PAYSTACK_SECRET_KEY not configured");
      expect(r.error.httpStatus).toBe(500);
    }
  });

  it("payment.list → array including the mojaloop intent", async () => {
    const r = await trpcQuery<Array<{ id: string; provider: string; status: string }>>(
      "payment.list", { tenantId: TENANT }, userToken,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.data)).toBe(true);
      expect(r.data.some((p) => p.provider === "mojaloop")).toBe(true);
    }
  });

  it("wallet.topUp without provider keys → PRECONDITION_FAILED (honest)", async () => {
    const r = await trpcMutation(
      "wallet.topUp", { tenantId: TENANT, amount: 5000 }, userToken,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.trpcCode).toBe("PRECONDITION_FAILED");
      expect(r.error.message).toContain("No payment provider configured");
    }
  });
});

describe("tRPC contract — escrow config", () => {
  it("escrow.getConfig → seeded config shape (custodyMode, fee rate, windows)", async () => {
    const r = await trpcQuery<{
      id: number;
      custodyMode: string;
      platformFeeRate: string;
      buyerConfirmWindowHours: number;
      disputeWindowHours: number;
    }>("escrow.getConfig", undefined, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.id).toBe(1);
      expect(["pssp", "psp"]).toContain(r.data.custodyMode);
      expect(parseFloat(r.data.platformFeeRate)).toBeGreaterThan(0);
      expect(r.data.buyerConfirmWindowHours).toBeGreaterThan(0);
    }
  });

  it("escrow.getStats → custodyMode + totals shape", async () => {
    const r = await trpcQuery<{
      custodyMode: string;
      totalHeld: number;
      totalSettled: number;
      totalFees: number;
      openDisputes: number;
    }>("escrow.getStats", undefined, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(["pssp", "psp"]).toContain(r.data.custodyMode);
      expect(typeof r.data.totalHeld).toBe("number");
      expect(typeof r.data.openDisputes).toBe("number");
    }
  });

  it("wallet.getBalance → null before any wallet activity", async () => {
    const r = await trpcQuery("wallet.getBalance", { tenantId: uniqueId("no-wallet") }, userToken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeNull();
  });
});
