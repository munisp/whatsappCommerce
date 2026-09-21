/**
 * QA-038 part 2/3: every server-side caller of ledger-bridge and recon-worker now sends
 * X-Internal-Api-Key when INTERNAL_API_KEY is configured — those services will start requiring it once
 * their own INTERNAL_API_KEY is set (see rust/ledger-bridge, rust/recon-worker). This is the "callers
 * send it" stage of the rollout; nothing enforces yet, but every call site is pinned here so the
 * enforcing stage cannot be flipped on before every caller is ready.
 *
 * Also pins the OTHER half: with INTERNAL_API_KEY unset (today's live state), no caller sends the
 * header — so this doesn't change any behavior against a bridge that isn't enforcing yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/trpc";

function ctxFor(user: { id: number; role: string } | null): TrpcContext {
  return {
    user: user
      ? ({ id: user.id, openId: `u${user.id}`, email: "a@e.c", name: "A", loginMethod: "manus", role: user.role, tenantId: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as TrpcContext["user"])
      : null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

type Call = { url: string; headers: Record<string, string> };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify({ status: "no_runs_yet", pending_id: "p1", replayed: false }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_KEY;
  vi.resetModules();
});

const headerNames = (h: Record<string, string>) => Object.keys(h).map((k) => k.toLowerCase());

describe("server/services/ledgerBridge.ts — ledgerBridgeRequest", () => {
  it("sends X-Internal-Api-Key when INTERNAL_API_KEY is configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    vi.resetModules();
    const { ledgerBridgeRequest } = await import("./services/ledgerBridge");
    await ledgerBridgeRequest("/health", "GET");
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
  });

  it("sends nothing extra when INTERNAL_API_KEY is unset (today's live state — must not break an enforcing-free bridge)", async () => {
    delete process.env.INTERNAL_API_KEY;
    vi.resetModules();
    const { ledgerBridgeRequest } = await import("./services/ledgerBridge");
    await ledgerBridgeRequest("/health", "GET");
    expect(headerNames(calls[0].headers)).not.toContain("x-internal-api-key");
  });

  it("postDirectLedgerLeg and reverseCommittedTransfer go through the same helper, so they inherit the header too", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    vi.resetModules();
    const { postDirectLedgerLeg, reverseCommittedTransfer } = await import("./services/ledgerBridge");
    await postDirectLedgerLeg({ debit_ref: "customer:+2348000000000", credit_ref: "escrow:t1", amount: 100, idempotency_key: "k1" }).catch(() => {});
    await reverseCommittedTransfer("p1", "test").catch(() => {});
    expect(calls.every((c) => c.headers["X-Internal-Api-Key"] === "s3cret")).toBe(true);
  });
});

describe("server/routers/payment.ts — ledgerRequest (payment.ts's own local copy)", () => {
  it("sends X-Internal-Api-Key when configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    vi.resetModules();
    const { ledgerRequest } = await import("./routers/payment");
    await ledgerRequest("/health", "GET");
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
  });

  it("sends nothing extra when unset", async () => {
    delete process.env.INTERNAL_API_KEY;
    vi.resetModules();
    const { ledgerRequest } = await import("./routers/payment");
    await ledgerRequest("/health", "GET");
    expect(headerNames(calls[0].headers)).not.toContain("x-internal-api-key");
  });
});

describe("server/routers/infra.ts — recon-worker calls (triggerReconciliation, getLastReconciliation)", () => {
  const admin = () => appRouter.createCaller(ctxFor({ id: 1, role: "admin" }));

  it("triggerReconciliation sends the header when configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.triggerReconciliation().catch(() => {}); // response shape isn't what's under test here
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
    expect(calls[0].url).toContain("/recon/trigger");
  });

  it("triggerReconciliation sends nothing extra when unset", async () => {
    delete process.env.INTERNAL_API_KEY;
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.triggerReconciliation().catch(() => {});
    expect(headerNames(calls[0]?.headers ?? {})).not.toContain("x-internal-api-key");
  });

  it("getLastReconciliation sends the header when configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.getLastReconciliation();
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
    expect(calls[0].url).toContain("/recon/last");
  });

  it("getLastReconciliation sends nothing extra when unset", async () => {
    delete process.env.INTERNAL_API_KEY;
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.getLastReconciliation();
    expect(headerNames(calls[0].headers)).not.toContain("x-internal-api-key");
  });
});
