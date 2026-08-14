/**
 * assuranceR1.test.ts — regression tests for the assurance-audit R1 fixes.
 *
 *   A1-01  creditRepayLink: runCreditRepaymentHook must not silently swallow an
 *          applyRepayment REFUSAL ({ok:false}) — claim released, durable
 *          settlement_retry marker persisted, critical captureException fired,
 *          truthful {applied:false, reason:'apply-refused'} returned.
 *   A2-01  hermes.saveConfig: cross-tenant upsert → FORBIDDEN; owner/operator
 *          of the tenant → ok; analyst → FORBIDDEN (operatorProcedure).
 *   A2-03  broadcastAb.selectWinner/autoSelectWinner: cross-tenant → FORBIDDEN.
 *   A2-04  broadcastAb.listAbTests/getAbResults: unauthenticated → UNAUTHORIZED;
 *          cross-tenant → FORBIDDEN.
 *   A2-05  whatsappNotifications.sendAdminReply/sendAttachment with a foreign
 *          orderId → FORBIDDEN (order's tenant owns the sender credentials).
 *   A2-06  whatsappNotifications.markReplyRead/Unread + temporal.getStatus/
 *          getRun cross-tenant → FORBIDDEN.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted spies + mocks ────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  captureException: vi.fn(),
  recordUsage: vi.fn(async () => 1),
  db: null as any,
  // membership directory `${userId}:${tenantId}` → role
  directory: new Map<string, { role: "owner" | "operator" | "analyst" }>(),
}));

vi.mock("./services/observability", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, captureException: h.captureException };
});
vi.mock("./services/metering", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, recordUsage: h.recordUsage };
});
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => h.db) };
});
vi.mock("./services/membership", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/membership")>();
  return {
    ...orig,
    getMembership: async (userId: string | number, tenantId: string) => {
      const m = h.directory.get(`${userId}:${tenantId}`);
      return m
        ? { id: "x", tenantId, userId: String(userId), role: m.role, invitedBy: null, createdAt: new Date() }
        : null;
    },
  };
});
vi.mock("./storage", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    storagePut: vi.fn(async (key: string) => ({ url: `https://cdn.example/${key}`, key })),
  };
});

import { runCreditRepaymentHook, __setApplyRepaymentForTests } from "./services/creditRepayLink";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ── Shared helpers ───────────────────────────────────────────────────────────
function ctxFor(user: { id: number; role: string; tenantId?: string | null } | null): TrpcContext {
  return {
    user: user
      ? ({
          id: user.id,
          openId: `u${user.id}`,
          email: "t@e.c",
          name: "T",
          loginMethod: "manus",
          role: user.role,
          tenantId: user.tenantId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: new Date(),
        } as TrpcContext["user"])
      : null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

/**
 * Generic chainable/thenable fake db. `queue` is a list of row-sets: every
 * terminal await shifts the next set. All builder methods return the chain.
 */
function makeChainDb(queue: any[][]) {
  const inserts: any[] = [];
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") {
        const rows = queue.length ? queue[0] : [];
        return (res: any) => res(rows);
      }
      return (...args: any[]) => {
        if (prop === "values") inserts.push(args[0]);
        return chain;
      };
    },
    apply: () => chain,
  });
  const db: any = new Proxy({ inserts }, {
    get: (t, prop) => {
      if (prop === "then" || typeof prop === "symbol") return undefined; // never thenable (await getDb())
      if (prop === "inserts") return t.inserts;
      if (prop === "execute") return async () => [];
      return () => chain;
    },
  });
  return db;
}

/** db for the repayment hook: PK-collision dedupe ledger + marker inserts. */
function makeDedupeDb() {
  const ledger = new Set<string>();
  const markerInserts: any[] = [];
  const db = {
    ledger,
    markerInserts,
    insert: (table: any) => ({
      values: (v: any) => {
        const name = (table as any)?.[Symbol.for("drizzle:Name")] ?? "";
        if (String(name).includes("processed_webhook_events") || (v && typeof v.id === "string" && v.id.startsWith("credit-repayment:"))) {
          const isNew = !ledger.has(v.id);
          if (isNew) ledger.add(v.id);
          return { onConflictDoNothing: () => ({ returning: async () => (isNew ? [{ id: v.id }] : []) }) };
        }
        markerInserts.push(v);
        return { then: (res: any) => res([]) };
      },
    }),
    delete: () => ({
      where: () => {
        ledger.clear(); // single-claim tests
        return { catch: (fn: any) => ({ then: (res: any) => res([]) }), then: (res: any) => res([]) };
      },
    }),
    execute: async () => [],
  };
  return db as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.directory.clear();
  h.db = null;
  __setApplyRepaymentForTests(null);
});

// ── A1-01: repayment refusal must not be silent ──────────────────────────────
describe("A1-01 runCreditRepaymentHook refusal handling", () => {
  const base = {
    tenantId: "buyer-t",
    reference: "CRP-refuse-1",
    amountMajor: 400,
    metadata: { kind: "credit_repayment", accountId: "acct-1" },
  };

  it("reports applied:false, releases the claim, persists a settlement_retry marker and captures critical on refusal", async () => {
    const db = makeDedupeDb();
    const apply = vi.fn(async () => ({ ok: false, outstandingAfter: 100_000 }));
    __setApplyRepaymentForTests(apply as any);

    const res = await runCreditRepaymentHook(db, base);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("apply-refused");

    // Critical observability capture fired.
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException.mock.calls[0][1]).toMatchObject({
      service: "creditRepayLink",
      severity: "critical",
    });

    // Durable settlement_retry marker persisted on the credit ledger.
    expect(db.markerInserts).toHaveLength(1);
    expect(db.markerInserts[0]).toMatchObject({ kind: "adjustment", amountCents: 0, ref: "CRP-refuse-1" });
    expect(db.markerInserts[0].note).toContain("[settlement_retry]");

    // Usage metric NOT incremented for the refused apply.
    expect(h.recordUsage).not.toHaveBeenCalledWith(db, "buyer-t", "credit_repayments_applied");

    // Claim released → a replay can retry and succeed (not a silent dead-end).
    const applyOk = vi.fn(async () => ({ ok: true, outstandingAfter: 60_000 }));
    __setApplyRepaymentForTests(applyOk as any);
    const retry = await runCreditRepaymentHook(db, base);
    expect(retry).toMatchObject({ applied: true, outstandingAfter: 60_000 });
    expect(applyOk).toHaveBeenCalledTimes(1);
  });

  it("happy path unchanged: successful apply returns applied:true and keeps the claim (replay skipped)", async () => {
    const db = makeDedupeDb();
    const apply = vi.fn(async () => ({ ok: true, outstandingAfter: 60_000 }));
    __setApplyRepaymentForTests(apply as any);
    const r1 = await runCreditRepaymentHook(db, base);
    expect(r1).toMatchObject({ applied: true, outstandingAfter: 60_000 });
    const r2 = await runCreditRepaymentHook(db, base);
    expect(r2).toMatchObject({ applied: false, reason: "duplicate" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(h.captureException).not.toHaveBeenCalled();
  });
});

// ── A2-01: hermes.saveConfig IDOR ────────────────────────────────────────────
describe("A2-01 hermes.saveConfig tenant authz", () => {
  const cfg = { tenantId: "tenant-b", hermesAgentUrl: "https://evil.example", active: true };

  it("rejects a cross-tenant upsert (FORBIDDEN) for an owner of another tenant", async () => {
    h.directory.set("1:tenant-a", { role: "owner" });
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.hermes.saveConfig(cfg)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an analyst of the target tenant (operatorProcedure)", async () => {
    h.directory.set("2:tenant-b", { role: "analyst" });
    const caller = appRouter.createCaller(ctxFor({ id: 2, role: "user", tenantId: "tenant-b" }));
    await expect(caller.hermes.saveConfig(cfg)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an owner/operator of the tenant", async () => {
    h.directory.set("3:tenant-b", { role: "owner" });
    h.db = makeChainDb([]);
    const caller = appRouter.createCaller(ctxFor({ id: 3, role: "user", tenantId: "tenant-b" }));
    await expect(caller.hermes.saveConfig(cfg)).resolves.toMatchObject({ success: true });
  });

  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    const caller = appRouter.createCaller(ctxFor(null));
    await expect(caller.hermes.saveConfig(cfg)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ── A2-03/A2-04: broadcastAb ─────────────────────────────────────────────────
describe("A2-03/04 broadcastAb tenant authz", () => {
  const abRow = { id: "ab-1", campaignId: "camp-1", tenantId: "tenant-b", winnerCriteria: "read_rate", variantASent: 0, variantARead: 0, variantADelivered: 0, variantBSent: 0, variantBRead: 0, variantBDelivered: 0 };

  it("selectWinner cross-tenant → FORBIDDEN", async () => {
    h.db = makeChainDb([[abRow]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.broadcastAb.selectWinner({ abTestId: "ab-1", winnerVariant: "A" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("autoSelectWinner cross-tenant → FORBIDDEN", async () => {
    h.db = makeChainDb([[abRow]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.broadcastAb.autoSelectWinner({ abTestId: "ab-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listAbTests cross-tenant → FORBIDDEN; unauthenticated → UNAUTHORIZED", async () => {
    h.db = makeChainDb([[]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.broadcastAb.listAbTests({ tenantId: "tenant-b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const anon = appRouter.createCaller(ctxFor(null));
    await expect(anon.broadcastAb.listAbTests({ tenantId: "tenant-b" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("getAbResults cross-tenant → FORBIDDEN; unauthenticated → UNAUTHORIZED", async () => {
    h.db = makeChainDb([[abRow]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.broadcastAb.getAbResults({ campaignId: "camp-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const anon = appRouter.createCaller(ctxFor(null));
    await expect(anon.broadcastAb.getAbResults({ campaignId: "camp-1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("same-tenant caller can still read results and select a winner", async () => {
    h.db = makeChainDb([[abRow], [abRow]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-b" }));
    await expect(caller.broadcastAb.getAbResults({ campaignId: "camp-1" })).resolves.toMatchObject({ id: "ab-1" });
    await expect(caller.broadcastAb.selectWinner({ abTestId: "ab-1", winnerVariant: "B" })).resolves.toMatchObject({ success: true });
  });
});

// ── A2-05/A2-06: whatsappNotifications ───────────────────────────────────────
describe("A2-05/06 whatsappNotifications tenant authz", () => {
  it("sendAdminReply with a foreign orderId → FORBIDDEN", async () => {
    h.db = makeChainDb([[{ tenantId: "tenant-b" }]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(
      caller.whatsappNotifications.sendAdminReply({ phone: "+2348000000000", message: "hi", orderId: "order-b" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("sendAttachment with a foreign orderId → FORBIDDEN", async () => {
    h.db = makeChainDb([[{ tenantId: "tenant-b" }]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(
      caller.whatsappNotifications.sendAttachment({
        phone: "+2348000000000",
        orderId: "order-b",
        fileBase64: Buffer.from("x").toString("base64"),
        fileName: "x.png",
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("markReplyRead / markReplyUnread on a foreign reply → FORBIDDEN", async () => {
    h.db = makeChainDb([[{ tenantId: "tenant-b" }], [{ tenantId: "tenant-b" }]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.whatsappNotifications.markReplyRead({ replyId: "r-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.whatsappNotifications.markReplyUnread({ replyId: "r-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("markReplyRead on own-tenant reply → success", async () => {
    h.db = makeChainDb([[{ tenantId: "tenant-a" }]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.whatsappNotifications.markReplyRead({ replyId: "r-1" })).resolves.toMatchObject({ success: true });
  });
});

// ── A2-06: temporal ──────────────────────────────────────────────────────────
describe("A2-06 temporal tenant authz", () => {
  it("getRun cross-tenant → FORBIDDEN", async () => {
    h.db = makeChainDb([[{ runId: "run-1", tenantId: "tenant-b", status: "running" }]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.temporal.getRun({ runId: "run-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("getStatus cross-tenant → FORBIDDEN", async () => {
    h.db = makeChainDb([[{ tenantId: "tenant-b" }]]);
    const caller = appRouter.createCaller(ctxFor({ id: 1, role: "user", tenantId: "tenant-a" }));
    await expect(caller.temporal.getStatus({ workflowId: "wf-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
