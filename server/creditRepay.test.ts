/**
 * creditRepay.test.ts — wave-8 credit repayment rails:
 *  - Paystack repayment link creation + metadata round-trip (intent + provider)
 *  - amount rules (full outstanding default, partial, >outstanding / zero rejected)
 *  - tenant isolation (service + router)
 *  - post-confirm hook exactly-once (dedupe claim; replay never double-applies)
 *  - claim-first paymentConfirm integration: confirm + webhook replay proof
 *  - hook failure → claim rollback → retry applies (and never throws into confirm)
 *  - over-partial repayment sequences
 *  - usage metering counters
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTableName, SQL } from "drizzle-orm";
import { ENV } from "./_core/env";
import {
  createRepaymentLink,
  runCreditRepaymentHook,
  CreditRepayError,
  __setApplyRepaymentForTests,
  METRIC_CREDIT_REPAYMENT_LINKS,
  METRIC_CREDIT_REPAYMENTS_APPLIED,
} from "./services/creditRepayLink";
import { confirmProviderPayment } from "./services/paymentConfirm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ── Module mocks ─────────────────────────────────────────────────────────────
const recordUsageSpy = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("./services/metering", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, recordUsage: recordUsageSpy };
});

const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => dbHolder.db) };
});

// paymentConfirm side-effect modules: keep the real money path, stub the
// peripherals (wallet credit, reservations, receipts, outbox fan-out).
vi.mock("./routers/escrow", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, creditWalletTopUp: vi.fn(async () => ({ credited: false, reason: "test" })) };
});
vi.mock("./services/inventory", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, commitReservations: vi.fn(async () => 0) };
});
vi.mock("./services/receipts", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, sendOrderReceipt: vi.fn(async () => ({ sent: false, reason: "test" })) };
});
vi.mock("./services/integrations/outbox", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, syncLocalChange: vi.fn(async () => []) };
});

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  self.onConflictDoNothing = () => thenable(rows);
  self.onConflictDoUpdate = () => thenable(rows);
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

function sqlInfo(q: any): { text: string; params: any[] } {
  const chunks = (q as any)?.queryChunks ?? [];
  let text = "";
  const params: any[] = [];
  for (const c of chunks) {
    if (Array.isArray(c?.value)) text += c.value.join("");
    else if (c instanceof SQL) {
      const sub = sqlInfo(c);
      text += sub.text;
      params.push(...sub.params);
    } else {
      text += "?";
      params.push(c);
    }
  }
  return { text, params };
}

function stubPaystack(url = "https://pay.example/pay/abc123") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: any, init: any) => {
      calls.push({ url: String(u), init: init ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: true, data: { authorization_url: url } }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return calls;
}

/** db for createRepaymentLink: raw-SQL credit account + intent insert/update capture. */
function makeLinkDb(accountRows: Array<Record<string, unknown>>) {
  const intentInserts: any[] = [];
  const intentUpdates: any[] = [];
  const db = {
    execute: async (q: any) => {
      const { text } = sqlInfo(q);
      if (text.includes("credit_accounts")) return accountRows;
      return [];
    },
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

/** db for runCreditRepaymentHook: processed_webhook_events PK-collision ledger. */
function makeDedupeDb() {
  const ledger = new Set<string>();
  const db = {
    ledger,
    insert: (table: any) => ({
      values: (v: any) => {
        if (tname(table) === "processed_webhook_events") {
          const isNew = !ledger.has(v.id);
          if (isNew) ledger.add(v.id);
          return { onConflictDoNothing: () => ({ returning: async () => (isNew ? [{ id: v.id }] : []) }) };
        }
        return thenable([]);
      },
    }),
    delete: (table: any) => ({
      where: () => {
        if (tname(table) === "processed_webhook_events") ledger.clear(); // single-claim tests
        return thenable([]);
      },
    }),
    execute: async () => [],
  };
  return db;
}

const ACCOUNT = { id: "acct-1", buyer_tenant_id: "buyer-t", outstanding_cents: 100_000, currency: "NGN" };

beforeEach(() => {
  vi.restoreAllMocks();
  recordUsageSpy.mockClear();
  dbHolder.db = null;
  __setApplyRepaymentForTests(null);
  ENV.paystackSecretKey = "sk_test_wave8";
});
afterEach(() => vi.unstubAllGlobals());

// ── Link creation ────────────────────────────────────────────────────────────
describe("createRepaymentLink", () => {
  it("creates an intent + Paystack link; credit_repayment metadata round-trips on both", async () => {
    const db = makeLinkDb([ACCOUNT]);
    const calls = stubPaystack();
    const res = await createRepaymentLink(db, {
      buyerTenantId: "buyer-t",
      accountId: "acct-1",
      poId: "po-9",
      customerPhone: "+2348000000000",
    });
    expect(res.paymentUrl).toBe("https://pay.example/pay/abc123");
    expect(res.amountCents).toBe(100_000); // default = full outstanding
    expect(res.outstandingCents).toBe(100_000);

    // Intent carries the metadata the post-confirm hook keys on.
    expect(db.intentInserts).toHaveLength(1);
    const intent = db.intentInserts[0];
    expect(intent.metadata).toMatchObject({ kind: "credit_repayment", accountId: "acct-1", poId: "po-9", tenantId: "buyer-t" });
    expect(intent.provider).toBe("paystack");
    expect(intent.amount).toBe("1000.00");
    expect(intent.providerPaymentId).toBe(res.reference);

    // Paystack initialize got the same reference + repayment metadata.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.paystack.co/transaction/initialize");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.reference).toBe(res.reference);
    expect(body.amount).toBe(100_000);
    expect(body.metadata).toMatchObject({ kind: "credit_repayment", accountId: "acct-1", poId: "po-9", tenant_id: "buyer-t" });
    expect((calls[0].init.headers as any)["Authorization"]).toBe("Bearer sk_test_wave8");

    // Metered.
    expect(recordUsageSpy).toHaveBeenCalledWith(db, "buyer-t", METRIC_CREDIT_REPAYMENT_LINKS);
  });

  it("respects a partial amount", async () => {
    const db = makeLinkDb([ACCOUNT]);
    stubPaystack();
    const res = await createRepaymentLink(db, { buyerTenantId: "buyer-t", accountId: "acct-1", amountCents: 25_000 });
    expect(res.amountCents).toBe(25_000);
    expect(db.intentInserts[0].amount).toBe("250.00");
  });

  it("rejects amounts above the outstanding balance and non-positive amounts", async () => {
    const db = makeLinkDb([ACCOUNT]);
    await expect(
      createRepaymentLink(db, { buyerTenantId: "buyer-t", accountId: "acct-1", amountCents: 100_001 }),
    ).rejects.toMatchObject({ name: "CreditRepayError", code: "amount-exceeds-outstanding" });
    await expect(
      createRepaymentLink(db, { buyerTenantId: "buyer-t", accountId: "acct-1", amountCents: 0 }),
    ).rejects.toMatchObject({ code: "invalid-amount" });
  });

  it("rejects unknown accounts, other-tenant accounts and settled accounts", async () => {
    await expect(
      createRepaymentLink(makeLinkDb([]), { buyerTenantId: "buyer-t", accountId: "nope" }),
    ).rejects.toMatchObject({ code: "credit-account-not-found" });
    await expect(
      createRepaymentLink(makeLinkDb([{ ...ACCOUNT, buyer_tenant_id: "other-t" }]), {
        buyerTenantId: "buyer-t",
        accountId: "acct-1",
      }),
    ).rejects.toMatchObject({ code: "credit-account-forbidden" });
    await expect(
      createRepaymentLink(makeLinkDb([{ ...ACCOUNT, outstanding_cents: 0 }]), {
        buyerTenantId: "buyer-t",
        accountId: "acct-1",
      }),
    ).rejects.toMatchObject({ code: "nothing-outstanding" });
  });

  it("marks the intent failed and throws when Paystack init fails", async () => {
    const db = makeLinkDb([ACCOUNT]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "down" }) as unknown as Response),
    );
    await expect(createRepaymentLink(db, { buyerTenantId: "buyer-t", accountId: "acct-1" })).rejects.toMatchObject({
      code: "paystack-init-failed",
    });
    expect(db.intentUpdates.at(-1)).toMatchObject({ status: "failed" });
  });
});

// ── Router tenant isolation ──────────────────────────────────────────────────
function makeCtx(role: "admin" | "user", tenantId?: string): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "t@e.c",
      name: "T",
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

describe("creditRepay.requestRepaymentLink router", () => {
  it("rejects cross-tenant requests (FORBIDDEN) before touching the DB", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "tenant-a"));
    await expect(
      caller.creditRepay.requestRepaymentLink({ tenantId: "tenant-b", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    const caller = appRouter.createCaller({ ...makeCtx("user", "buyer-t"), user: null });
    await expect(
      caller.creditRepay.requestRepaymentLink({ tenantId: "buyer-t", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("maps a foreign credit account to FORBIDDEN (defense in depth after assertTenantAccess)", async () => {
    dbHolder.db = makeLinkDb([{ ...ACCOUNT, buyer_tenant_id: "supplier-t" }]);
    stubPaystack();
    const caller = appRouter.createCaller(makeCtx("user", "buyer-t"));
    await expect(
      caller.creditRepay.requestRepaymentLink({ tenantId: "buyer-t", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("happy path returns the Paystack link for the buyer's own account", async () => {
    dbHolder.db = makeLinkDb([ACCOUNT]);
    stubPaystack();
    const caller = appRouter.createCaller(makeCtx("user", "buyer-t"));
    const res = await caller.creditRepay.requestRepaymentLink({
      tenantId: "buyer-t",
      accountId: "acct-1",
      amountCents: 40_000,
    });
    expect(res.paymentUrl).toContain("https://");
    expect(res.amountCents).toBe(40_000);
  });
});

// ── Post-confirm hook: exactly-once ──────────────────────────────────────────
describe("runCreditRepaymentHook", () => {
  const base = { tenantId: "buyer-t", reference: "CRP-1", amountMajor: 400, metadata: { kind: "credit_repayment", accountId: "acct-1" } };

  it("applies the repayment once; a duplicate claim is skipped", async () => {
    const db = makeDedupeDb();
    const apply = vi.fn(async () => ({ ok: true, outstandingAfter: 60_000 }));
    __setApplyRepaymentForTests(apply);
    const r1 = await runCreditRepaymentHook(db, base);
    expect(r1).toMatchObject({ applied: true, outstandingAfter: 60_000 });
    expect(apply).toHaveBeenCalledWith({ accountId: "acct-1", amountCents: 40_000, ref: "CRP-1" });
    expect(recordUsageSpy).toHaveBeenCalledWith(db, "buyer-t", METRIC_CREDIT_REPAYMENTS_APPLIED);

    const r2 = await runCreditRepaymentHook(db, base); // replayed webhook
    expect(r2).toMatchObject({ applied: false, reason: "duplicate" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("ignores non-repayment metadata", async () => {
    const db = makeDedupeDb();
    const apply = vi.fn(async () => ({ ok: true, outstandingAfter: 0 }));
    __setApplyRepaymentForTests(apply);
    const res = await runCreditRepaymentHook(db, { ...base, metadata: { kind: "wallet_topup" } });
    expect(res.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("on apply failure the claim is rolled back so a retry can re-apply", async () => {
    const db = makeDedupeDb();
    let calls = 0;
    __setApplyRepaymentForTests(
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("tradeCredit down");
        return { ok: true, outstandingAfter: 0 };
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Honest contract: the hook NEVER throws — it reports a typed failure.
    const failed = await runCreditRepaymentHook(db, base);
    expect(failed.applied).toBe(false);
    expect(failed.reason).toMatch(/^apply-failed: tradeCredit down/);
    errSpy.mockRestore();
    expect(db.ledger.size).toBe(0); // claim rolled back
    const retry = await runCreditRepaymentHook(db, base);
    expect(retry.applied).toBe(true);
  });

  it("over-partial repayment sequence: two partials draw the outstanding down", async () => {
    const db = makeDedupeDb();
    let outstanding = 100_000;
    const applied: number[] = [];
    __setApplyRepaymentForTests(
      vi.fn(async ({ amountCents }: { amountCents: number }) => {
        outstanding -= amountCents;
        applied.push(amountCents);
        return { ok: true, outstandingAfter: outstanding };
      }),
    );
    const r1 = await runCreditRepaymentHook(db, { ...base, reference: "CRP-p1", amountMajor: 400 });
    const r2 = await runCreditRepaymentHook(db, { ...base, reference: "CRP-p2", amountMajor: 600 });
    expect(r1).toMatchObject({ applied: true, outstandingAfter: 60_000 });
    expect(r2).toMatchObject({ applied: true, outstandingAfter: 0 });
    expect(applied).toEqual([40_000, 60_000]);
  });
});

// ── Claim-first confirm integration: webhook replay never double-applies ─────
describe("confirmProviderPayment credit_repayment hook", () => {
  function makeConfirmDb(intent: Record<string, any>, opts: { orderRow?: any } = {}) {
    const ledger = new Set<string>();
    const escrowInserted: any[] = [];
    const db: any = {
      ledger,
      escrowInserted,
      select: () => ({
        from: (table: any) => ({
          where: () => {
            const rows = (() => {
              switch (tname(table)) {
                case "payment_transactions":
                  return [];
                case "payment_intents":
                  return [{ ...intent }];
                case "orders":
                  return opts.orderRow ? [opts.orderRow] : [];
                case "escrow_config":
                  return []; // defaults (pssp custody)
                default:
                  return [];
              }
            })();
            const self: any = thenable(rows);
            self.limit = async () => rows;
            return self;
          },
        }),
      }),
      update: (table: any) => ({
        set: (setObj: any) => ({
          where: () => {
            let appliedRows: any[] = [];
            if (tname(table) === "payment_intents" && intent.status !== "completed") {
              intent.status = "completed"; // claim-first guarded transition
              appliedRows = [{ id: intent.id }];
            }
            return thenable(appliedRows);
          },
        }),
      }),
      insert: (table: any) => ({
        values: (v: any) => {
          const name = tname(table);
          if (name === "processed_webhook_events") {
            const isNew = !ledger.has(v.id);
            if (isNew) ledger.add(v.id);
            return { onConflictDoNothing: () => ({ returning: async () => (isNew ? [{ id: v.id }] : []) }) };
          }
          if (name === "escrow_transactions") escrowInserted.push(v);
          return thenable([]);
        },
      }),
      delete: () => ({ where: () => thenable([]) }),
      execute: async () => [],
    };
    return db;
  }

  const makeIntent = () => ({
    id: "pi-crp-1",
    tenantId: "buyer-t",
    orderId: "acct-1",
    customerId: "+2348000000000",
    amount: "1000.00",
    currency: "NGN",
    provider: "paystack",
    status: "pending",
    providerPaymentId: "CRP-REPLAY-1",
    metadata: { kind: "credit_repayment", accountId: "acct-1", tenantId: "buyer-t" },
  });

  it("confirmed repayment link applies the repayment exactly once", async () => {
    const intent = makeIntent();
    const db = makeConfirmDb(intent);
    const apply = vi.fn(async () => ({ ok: true, outstandingAfter: 0 }));
    __setApplyRepaymentForTests(apply);

    const res = await confirmProviderPayment(db, {
      provider: "paystack",
      reference: "CRP-REPLAY-1",
      amountMajor: 1000,
      currency: "NGN",
      rawPayload: { event: "charge.success" },
    });
    expect(res.action).toBe("confirmed");
    expect(intent.status).toBe("completed"); // claim-first transition happened
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ accountId: "acct-1", amountCents: 100_000, ref: "CRP-REPLAY-1" });
    expect(db.ledger.has("credit-repayment:CRP-REPLAY-1")).toBe(true);
  });

  it("replayed webhook: already-completed + dedupe claim → NO double-apply", async () => {
    const intent = makeIntent();
    const db = makeConfirmDb(intent);
    const apply = vi.fn(async () => ({ ok: true, outstandingAfter: 0 }));
    __setApplyRepaymentForTests(apply);

    const first = await confirmProviderPayment(db, {
      provider: "paystack",
      reference: "CRP-REPLAY-1",
      amountMajor: 1000,
      currency: "NGN",
      rawPayload: {},
    });
    expect(first.action).toBe("confirmed");

    const replay = await confirmProviderPayment(db, {
      provider: "paystack",
      reference: "CRP-REPLAY-1",
      amountMajor: 1000,
      currency: "NGN",
      rawPayload: {},
    });
    expect(replay.action).toBe("already-completed");
    expect(apply).toHaveBeenCalledTimes(1); // claim-first + dedupe proof
  });

  it("hook failure is logged but the payment stays confirmed", async () => {
    const intent = makeIntent();
    const db = makeConfirmDb(intent);
    __setApplyRepaymentForTests(
      vi.fn(async () => {
        throw new Error("tradeCredit unavailable");
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await confirmProviderPayment(db, {
      provider: "paystack",
      reference: "CRP-REPLAY-1",
      amountMajor: 1000,
      currency: "NGN",
      rawPayload: {},
    });
    expect(res.action).toBe("confirmed"); // payment itself is safe
    expect(intent.status).toBe("completed");
    errSpy.mockRestore();
  });

  // ── Escrow gate regression (wave-8 FK violation fix) ─────────────────────
  // paymentConfirm reuses paymentIntents.orderId for NON-order references
  // (credit_repayment carries the account/PO uuid). The order-confirmation /
  // escrow-hold block must only fire when the reference is a REAL orders row.
  it("escrow gate: non-order intent references NEVER create escrow-hold rows", async () => {
    const intent = makeIntent(); // orderId = "acct-1" — a credit account, not an order
    const db = makeConfirmDb(intent); // orders table has no such row
    __setApplyRepaymentForTests(vi.fn(async () => ({ ok: true, outstandingAfter: 0 })));
    const res = await confirmProviderPayment(db, {
      provider: "paystack",
      reference: "CRP-REPLAY-1",
      amountMajor: 1000,
      currency: "NGN",
      rawPayload: {},
    });
    expect(res.action).toBe("confirmed");
    expect(db.escrowInserted).toHaveLength(0); // gate suppressed the escrow block
  });

  it("escrow gate: a real orders row still gets its escrow hold (positive control)", async () => {
    const intent = { ...makeIntent(), metadata: { kind: "storefront" }, orderId: "order-1" };
    const db = makeConfirmDb(intent, { orderRow: { id: "order-1" } });
    __setApplyRepaymentForTests(vi.fn(async () => ({ ok: true, outstandingAfter: 0 })));
    const res = await confirmProviderPayment(db, {
      provider: "paystack",
      reference: "CRP-REPLAY-1",
      amountMajor: 1000,
      currency: "NGN",
      rawPayload: {},
    });
    expect(res.action).toBe("confirmed");
    expect(db.escrowInserted).toHaveLength(1);
    expect(db.escrowInserted[0].orderId).toBe("order-1");
  });
});
