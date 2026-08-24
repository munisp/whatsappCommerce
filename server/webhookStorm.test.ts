/**
 * server/webhookStorm.test.ts — webhook-storm TOCTOU regression.
 *
 * 100 duplicate (signed, valid) provider webhook deliveries for the SAME
 * payment reference arrive concurrently. The confirm flow must produce
 * EXACTLY ONE side-effect (one ledger commit, one completed transition) and
 * 99 already-completed skips.
 *
 * Regression: the old flow ran the ledger commit BEFORE the guarded status
 * transition, so every concurrent delivery passed the pre-check, committed
 * the ledger, and only then lost the race — a storm double-committed. The
 * fixed flow CLAIMS the intent first via an atomic guarded UPDATE
 * (WHERE status IN ('pending','initiated') RETURNING, rowCount check) and
 * only the claim holder performs the ledger commit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

// ─── In-memory payment_intents store with ATOMIC guarded-transition semantics ─
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
  completedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const store: { intent: IntentRow } = {
  intent: {
    id: "pi-storm-1",
    tenantId: "tenant-1",
    orderId: "order-1",
    amount: "5000.00",
    currency: "NGN",
    provider: "paystack",
    providerPaymentId: "PAY-STORM-REF",
    idempotencyKey: "payment:tenant-1:order-1",
    status: "initiated",
    customerId: "+2348000000000",
    ledgerPendingId: "11111111-2222-3333-4444-555555555555",
    failureReason: null,
    completedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

// Ledger-bridge call log (filled by the fetch mock).
const ledgerCalls: { path: string; body: any }[] = [];

function resetState() {
  store.intent.status = "initiated";
  store.intent.failureReason = null;
  store.intent.completedAt = null;
  store.intent.metadata = {};
  ledgerCalls.length = 0;
}

/**
 * Mock DB whose UPDATE emulates the atomic guarded transition: the status
 * check + flip happens synchronously (single atomic statement in real PG),
 * so only ONE concurrent caller can claim the intent.
 */
function makeMockDb() {
  const applyUpdate = (vals: Partial<IntentRow>): IntentRow[] => {
    const s = store.intent.status;
    if (vals.status === "completed" || vals.status === "failed") {
      // Claim path: guarded by WHERE status IN ('pending','initiated').
      if (s !== "pending" && s !== "initiated") return [];
    }
    if (vals.status === "pending") {
      // Claim-rollback path: guarded by WHERE status IN ('completed','failed').
      if (s !== "completed" && s !== "failed") return [];
    }
    Object.assign(store.intent, vals);
    return [store.intent];
  };

  const updateChain = () => ({
    set: (vals: Partial<IntentRow>) => ({
      where: (_cond: unknown) => {
        // Apply the guarded update synchronously (atomic in real PG), then
        // expose it as an awaitable chain with .returning() and .catch().
        const applied = applyUpdate(vals);
        const p = Promise.resolve(applied) as Promise<IntentRow[]> & {
          returning: (f?: unknown) => Promise<IntentRow[]>;
        };
        p.returning = (_f?: unknown) => Promise.resolve(applied);
        return p;
      },
    }),
  });

  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => {
            const row = fields && "status" in fields && Object.keys(fields).length === 1
              ? [{ status: store.intent.status }]
              : [{ ...store.intent }];
            return Promise.resolve(row);
          },
        }),
      }),
    }),
    update: (_table: unknown) => updateChain(),
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
// W30 merge (V2#4): payment.confirm now FAILS CLOSED on an inconclusive
// provider fetchStatus probe (admin override + step-up required). These storm
// tests target dedupe/claim semantics, not the probe gate, and no provider is
// configured for the fixture tenant — pin the probe to a conclusive success.
vi.mock("./services/payments/verifyProviderStatus", () => ({
  fetchProviderPaymentStatus: vi.fn(async () => ({ status: "success" })),
}));

// fetch mock: ledger-bridge calls are counted; event publishers succeed silently.
const fetchMock = vi.fn(async (url: any, init?: any) => {
  const u = String(url);
  const path = new URL(u).pathname;
  if (u.includes("ledger-bridge") || path.startsWith("/ledger") || path === "/transfer" || path === "/accounts/provision") {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    ledgerCalls.push({ path, body });
    return new Response(JSON.stringify({ status: "committed", pending_id: body?.pending_id }), { status: 200 });
  }
  // fluvio / dapr / anything else: succeed quietly.
  return new Response("{}", { status: 200 });
});
vi.stubGlobal("fetch", fetchMock);

const { appRouter } = await import("./routers");

function adminCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "storm-admin", email: "admin@example.com", name: "Admin",
      loginMethod: "manus", role: "admin",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("payment.confirm — 100 duplicate webhook deliveries (storm)", () => {
  beforeEach(resetState);

  it("produces exactly ONE side-effect and 99 already-completed skips", async () => {
    const caller = appRouter.createCaller(adminCtx());
    const payload = {
      reference: "PAY-STORM-REF",
      providerStatus: "success" as const,
      providerData: { id: 12345, gateway_response: "Approved" },
    };

    // 100 concurrent duplicate deliveries of the same signed webhook.
    const results = await Promise.all(
      Array.from({ length: 100 }, () => caller.payment.confirm(payload)),
    );

    const confirmed = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);

    expect(confirmed.length, "exactly one delivery may confirm").toBe(1);
    expect(skipped.length, "the other 99 must skip as already-completed").toBe(99);
    expect(confirmed[0].status).toBe("completed");
    for (const r of skipped) expect(r.status).toBe("completed");

    // Exactly ONE ledger side-effect: a single /ledger/commit for the
    // reservation — never a double-commit under the storm.
    const commits = ledgerCalls.filter((c) => c.path === "/ledger/commit");
    expect(commits.length).toBe(1);
    expect(commits[0].body.pending_id).toBe(store.intent.ledgerPendingId);

    // The intent ended completed exactly once.
    expect(store.intent.status).toBe("completed");
    expect(store.intent.completedAt).toBeInstanceOf(Date);
  });

  it("a sequential replay after completion skips without any ledger call", async () => {
    const caller = appRouter.createCaller(adminCtx());
    const payload = { reference: "PAY-STORM-REF", providerStatus: "success" as const };

    const first = await caller.payment.confirm(payload);
    expect(first.skipped).toBe(false);
    expect(ledgerCalls.filter((c) => c.path === "/ledger/commit").length).toBe(1);

    ledgerCalls.length = 0;
    const replay = await caller.payment.confirm(payload);
    expect(replay.skipped).toBe(true);
    expect(replay.status).toBe("completed");
    expect(ledgerCalls.filter((c) => c.path === "/ledger/commit").length).toBe(0);
  });

  it("claim rolls back when the ledger commit fails — no phantom completion", async () => {
    // Make the ledger commit fail for this scenario.
    fetchMock.mockImplementationOnce(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes("/ledger/commit")) {
        ledgerCalls.push({ path: "/ledger/commit", body: init?.body ? JSON.parse(init.body) : undefined });
        return new Response("ledger_unavailable", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    });

    const caller = appRouter.createCaller(adminCtx());
    await expect(caller.payment.confirm({
      reference: "PAY-STORM-REF",
      providerStatus: "success",
    })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    // The claim was rolled back: the intent is pending again (retryable),
    // NOT completed, with a ledger_commit_failed reason recorded.
    expect(store.intent.status).toBe("pending");
    expect(store.intent.failureReason).toContain("ledger_commit_failed");
    expect(store.intent.completedAt).toBeNull();

    // Recovery: a retry after the ledger recovers succeeds.
    const retry = await caller.payment.confirm({ reference: "PAY-STORM-REF", providerStatus: "success" });
    expect(retry.skipped).toBe(false);
    expect(retry.status).toBe("completed");
  });
});
