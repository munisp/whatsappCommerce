/**
 * W22 graph-collusion router tests — tenant guards, happy path, idempotency.
 *
 * getDb is mocked to the shared tradeCredit fakeDb (extended for
 * graph_alerts), so the real tRPC procedures, the real scan service, and the
 * idempotency unique-key semantics are exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { makeFakeDb } from "./services/tradeCredit/fakeDb";

const NOW = new Date("2025-06-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function seedRing() {
  const users = [
    { tenantId: "ra", phone: "+234100" },
    { tenantId: "rb", phone: "+234101" },
    { tenantId: "rc", phone: "+234102" },
  ];
  const customers: { id: string; tenantId: string; whatsappPhone: string }[] = [];
  const orders: { tenantId: string; totalAmount: string; createdAt: Date; customerId: string }[] = [];
  const trade = (seller: string, buyerPhone: string, days: number) => {
    const cid = `c-${seller}-${buyerPhone.slice(-3)}`;
    if (!customers.some((c) => c.id === cid)) customers.push({ id: cid, tenantId: seller, whatsappPhone: buyerPhone });
    orders.push({ tenantId: seller, customerId: cid, totalAmount: "5000.00", createdAt: daysAgo(days) });
  };
  for (let i = 0; i < 4; i++) {
    trade("rb", "+234100", 2 + i); // ra → rb
    trade("rc", "+234101", 3 + i); // rb → rc
    trade("ra", "+234102", 4 + i); // rc → ra
  }
  return { users, customers, orders };
}

const fake = makeFakeDb(seedRing() as any);

vi.mock("./db", () => ({
  getDb: vi.fn(async () => fake.db),
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn(async () => true) }));
vi.mock("./kafka", () => ({
  publishOrderEvent: vi.fn().mockResolvedValue(undefined),
  publishConversationEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./dapr", () => ({
  daprPublish: vi.fn().mockResolvedValue(undefined),
  daprSaveState: vi.fn().mockResolvedValue(undefined),
}));

const { appRouter } = await import("./routers");

function makeCtx(role: "admin" | "user", tenantId?: string): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      tenantId: tenantId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const caller = (role: "admin" | "user", tenantId?: string) =>
  appRouter.createCaller(makeCtx(role, tenantId));

beforeEach(() => {
  fake.store.graphAlerts.length = 0;
});

describe("compliance.scanGraphCollusion / graphAlerts / updateGraphAlert", () => {
  it("happy path: scan flags the ring, lists alerts, ack/dismiss transitions work", async () => {
    const op = caller("user", "ra");
    const scan = await op.compliance.scanGraphCollusion({ tenantId: "ra", now: NOW.toISOString() });
    expect(scan.error).toBeUndefined();
    expect(scan.insufficient).toBe(false);
    expect(scan.alertsCreated).toBeGreaterThan(0);
    expect(new Set(scan.alerts.map((a: any) => a.buyerId))).toEqual(new Set(["ra", "rb", "rc"]));

    const open = await op.compliance.graphAlerts({ tenantId: "ra", status: "open" });
    expect(open.length).toBe(scan.alertsCreated);
    expect(open[0]).toHaveProperty("buyerId");
    expect(open[0]).toHaveProperty("signal");
    expect(open[0]).toHaveProperty("score");

    const ack = await op.compliance.updateGraphAlert({ alertId: open[0].id, status: "acknowledged" });
    expect(ack.ok).toBe(true);
    const acked = await op.compliance.graphAlerts({ tenantId: "ra", status: "acknowledged" });
    expect(acked.length).toBe(1);
    expect(acked[0].id).toBe(open[0].id);

    const dismiss = await op.compliance.updateGraphAlert({ alertId: open[1].id, status: "dismissed" });
    expect(dismiss.ok).toBe(true);
    expect((await op.compliance.graphAlerts({ tenantId: "ra", status: "dismissed" })).length).toBe(1);
    expect((await op.compliance.graphAlerts({ tenantId: "ra", status: "open" })).length).toBe(scan.alertsCreated - 2);
  });

  it("idempotency: re-scanning the same window bucket creates no duplicates", async () => {
    const op = caller("user", "ra");
    const first = await op.compliance.scanGraphCollusion({ tenantId: "ra", now: NOW.toISOString() });
    const second = await op.compliance.scanGraphCollusion({ tenantId: "ra", now: NOW.toISOString() });
    expect(second.alertsCreated).toBe(0);
    const all = await op.compliance.graphAlerts({ tenantId: "ra" });
    expect(all.length).toBe(first.alertsCreated);
  });

  it("tenant guards: cross-tenant scan/list/update are FORBIDDEN", async () => {
    const op = caller("user", "ra");
    await op.compliance.scanGraphCollusion({ tenantId: "ra", now: NOW.toISOString() });
    const open = await op.compliance.graphAlerts({ tenantId: "ra", status: "open" });

    const intruder = caller("user", "intruder");
    await expect(intruder.compliance.scanGraphCollusion({ tenantId: "ra" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.compliance.graphAlerts({ tenantId: "ra" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      intruder.compliance.updateGraphAlert({ alertId: open[0].id, status: "dismissed" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Unknown alert id → NOT_FOUND.
    await expect(
      op.compliance.updateGraphAlert({ alertId: "missing", status: "dismissed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The intruder sees only its own (empty) alert set.
    expect(await intruder.compliance.graphAlerts({ tenantId: "intruder" })).toEqual([]);
  });
});
