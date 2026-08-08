/**
 * server/ledgerOutage.test.ts — TigerBeetle/ledger-bridge outage behavior.
 *
 * Pins: with the ledger DOWN, payment.initiate fails HONESTLY — the intent is
 * marked failed with a ledger_failed reason and the error is surfaced (no
 * silent success with zero ledger entries). When the ledger recovers, the
 * retry succeeds: the failed intent under the same idempotency key is cleared
 * and a fresh reservation is made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

process.env.PAYSTACK_SECRET_KEY = "sk_test_ledgerOutage";
delete process.env.PERMIFY_URL;

// ─── In-memory payment_intents store ─────────────────────────────────────────
interface IntentRow {
  id: string;
  tenantId: string;
  orderId: string;
  amount: string;
  currency: string;
  provider: string;
  providerPaymentId: string;
  idempotencyKey: string;
  status: string;
  customerId: string;
  ledgerPendingId: string | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
let rows: IntentRow[] = [];
let ledgerDown = true;
const ledgerCalls: { path: string; body: any }[] = [];

function makeMockDb() {
  const thenable = (p: Promise<unknown>) => {
    const t = p as Promise<unknown> & { catch: (cb: () => void) => Promise<unknown> };
    return t;
  };
  return {
    select: (_fields?: Record<string, unknown>) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => Promise.resolve(rows.slice(0, 1)),
          orderBy: (_o: unknown) => ({
            limit: (_n: number) => Promise.resolve(rows.slice(0, 1)),
          }),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (vals: IntentRow) => {
        rows.push({ ledgerPendingId: null, failureReason: null, ...vals });
        return thenable(Promise.resolve([vals]));
      },
    }),
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => {
        // Single-row store: the reuse-or-clear path deletes the failed row.
        rows = [];
        return thenable(Promise.resolve([]));
      },
    }),
    update: (_table: unknown) => ({
      set: (vals: Partial<IntentRow>) => ({
        where: (_cond: unknown) => {
          rows = rows.map((r) => ({ ...r, ...vals }));
          return thenable(Promise.resolve([]));
        },
      }),
    }),
  };
}

vi.mock("./db", () => ({
  getDb: vi.fn(async () => makeMockDb()),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn(async () => true) }));
vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));
vi.mock("./dapr", () => ({
  publishPaymentEvent: vi.fn(async () => {}),
  daprPublish: vi.fn(async () => {}),
}));
// Temporal is unreachable in this sandbox — fail fast instead of hanging on
// a real connection attempt (production code already degrades to
// started:false on any saga-start failure).
vi.mock("@temporalio/client", () => ({
  Connection: { connect: vi.fn(async () => { throw new Error("temporal unreachable"); }) },
  Client: vi.fn(),
}));

vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
  const u = String(url);
  const path = u.startsWith("http") ? new URL(u).pathname : u;
  const body = init?.body ? JSON.parse(init.body) : undefined;

  if (path === "/transfer") {
    ledgerCalls.push({ path, body });
    if (ledgerDown) return new Response("ledger_unavailable", { status: 503 });
    return new Response(JSON.stringify({
      pending_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      status: "reserved", source: "tigerbeetle",
    }), { status: 201 });
  }
  if (path === "/accounts/provision") return new Response("{}", { status: 200 });
  if (path === "/ledger/void") return new Response("{}", { status: 200 });
  if (u.includes("api.paystack.co")) {
    return new Response(JSON.stringify({
      status: true,
      data: { authorization_url: "https://checkout.paystack.com/xyz" },
    }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

const { appRouter } = await import("./routers");

function userCtx(): TrpcContext {
  return {
    user: {
      id: 7, openId: "buyer-1", email: "buyer@example.com", name: "Buyer",
      loginMethod: "manus", role: "user", tenantId: "tenant-1",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const input = {
  tenantId: "tenant-1",
  orderId: "order-ledger-outage",
  amount: 2500,
  currency: "NGN" as const,
  provider: "paystack" as const,
  customerPhone: "+2348000000000",
};

describe("payment.initiate — TigerBeetle ledger outage", () => {
  beforeEach(() => {
    rows = [];
    ledgerCalls.length = 0;
    ledgerDown = true;
  });

  it("TB down → honest ledger_failed: error surfaced, intent marked failed, no phantom success", async () => {
    const caller = appRouter.createCaller(userCtx());
    await expect(caller.payment.initiate(input)).rejects.toThrow(/ledger_failed/);

    // The intent exists and is FAILED with the precise ledger_failed reason —
    // never a silent success with zero ledger entries.
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].failureReason).toContain("ledger_failed");
    expect(rows[0].ledgerPendingId).toBeNull();

    // Exactly one reserve attempt was made (and refused).
    expect(ledgerCalls.filter((c) => c.path === "/transfer").length).toBe(1);
  });

  it("retry after ledger recovery clears the failed intent and succeeds", async () => {
    const caller = appRouter.createCaller(userCtx());

    // Attempt 1: ledger down → fails.
    await expect(caller.payment.initiate(input)).rejects.toThrow(/ledger_failed/);
    expect(rows[0]?.status).toBe("failed");

    // Ledger recovers; retry the SAME order (same idempotency key).
    ledgerDown = false;
    const result = await caller.payment.initiate(input);
    expect(result.status).toBe("initiated");
    expect(result.tbDebitOk).toBe(true);
    expect(result.paymentUrl).toBe("https://checkout.paystack.com/xyz");

    // The failed intent was cleared and replaced by a single healthy intent.
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("initiated");
    expect(rows[0].ledgerPendingId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    // Two reserve attempts total: one refused, one accepted.
    expect(ledgerCalls.filter((c) => c.path === "/transfer").length).toBe(2);
  });
});
