/**
 * R3 — wallet.rejectWithdrawal:
 *  - rejecting a PENDING withdrawal restores the balance exactly once
 *    (pending→rejected conditional claim + escrow_refund reversal entry at
 *    `${ref}:reversal`, backed by the emulated 0053 wallet_tx_wallet_ref_uniq
 *    unique index);
 *  - a second reject is an idempotent no-op (no double refund);
 *  - PAID withdrawals are never touched (CONFLICT);
 *  - unknown reference → NOT_FOUND.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./routers/audit", () => ({ writeAuditLog: vi.fn(async () => {}) }));

import { getDb } from "./db";
import { walletRouter } from "./routers/escrow";
import { merchantWallets, walletTransactions } from "../drizzle/schema";

const ADMIN = { user: { id: "u-admin", role: "admin", tenantId: null, name: "Admin" } } as any;
const USER = { user: { id: "u-1", role: "user", tenantId: "tenant-1" } } as any;

interface WalletRow { id: string; tenantId: string; currency: string; availableBalance: string; totalWithdrawn: string; [k: string]: unknown }
interface TxRow { id: string; walletId: string; tenantId: string; type: string; amount: string; reference: string | null; metadata: any; [k: string]: unknown }

function makeDb(opts: { withdrawalStatus: string | null }) {
  const store = {
    wallets: [{
      id: "wal-1", tenantId: "tenant-1", currency: "NGN",
      availableBalance: "500.00", escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "500.00",
    }] as WalletRow[],
    walletTxs: opts.withdrawalStatus == null ? [] : [{
      id: "tx-wd-1", walletId: "wal-1", tenantId: "tenant-1", type: "withdrawal",
      amount: "500.00", balanceBefore: "1000.00", balanceAfter: "500.00", currency: "NGN",
      reference: "WD-REJ-1", metadata: { status: opts.withdrawalStatus },
      createdAt: new Date(),
    }] as TxRow[],
  };

  const tableName = (table: unknown): string => {
    if (table === merchantWallets) return "merchant_wallets";
    if (table === walletTransactions) return "wallet_transactions";
    throw new Error("fake db: unknown table");
  };

  // Decode drizzle eq/and conditions into { colName: value }.
  function decode(cond: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const walk = (c: unknown): void => {
      if (c == null) return;
      if (Array.isArray(c)) return c.forEach(walk);
      const o = c as any;
      if (typeof o !== "object") return;
      if (o.constructor?.name === "StringChunk") return;
      if (typeof o.name === "string") {
        // pending value binds to the most recent column seen
        pendingCol = o.name === "wallet_id" ? "walletId" : o.name === "tenant_id" ? "tenantId" : o.name;
        return;
      }
      if (Array.isArray(o.queryChunks)) return walk(o.queryChunks);
      if ("value" in o && pendingCol) { out[pendingCol] = o.value; pendingCol = null; return; }
    };
    let pendingCol: string | null = null;
    walk((cond as any)?.queryChunks ?? cond);
    return out;
  }

  function matches(row: any, cond: unknown, skipStatusCheck = false): boolean {
    const cols = decode(cond);
    for (const [k, v] of Object.entries(cols)) {
      if (k === "metadata") continue; // sql`metadata->>'status'='pending'` handled below
      if (row[k] !== v) return false;
    }
    return true;
  }

  const thenable = (get: () => any) => {
    const self: any = {};
    self.then = (res: (v: any) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(get).then(res, rej);
    self.catch = (rej: (e: unknown) => unknown) => Promise.resolve().then(get).catch(rej);
    return self;
  };

  const makeHandle = (): any => ({
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const t = tableName(table);
          return {
            where(cond: unknown) {
              const rows = (t === "merchant_wallets" ? store.wallets : store.walletTxs)
                .filter((r) => matches(r, cond))
                .map((r) => ({ ...r }));
              const chain: any = thenable(() => fields ? rows.map((r) => Object.fromEntries(Object.keys(fields).map((k) => [k, r[k]]))) : rows);
              chain.limit = () => chain;
              chain.orderBy = () => chain;
              return chain;
            },
          };
        },
      };
    },
    insert(table: unknown) {
      const t = tableName(table);
      return {
        values(vals: any) {
          const chain: any = thenable(() => {
            if (t === "wallet_transactions") {
              // Emulate wallet_tx_wallet_ref_uniq (0053).
              if (vals.reference != null &&
                  store.walletTxs.some((r) => r.walletId === vals.walletId && r.reference === vals.reference)) {
                const err: any = new Error(`duplicate key value violates unique constraint "wallet_tx_wallet_ref_uniq"`);
                err.code = "23505";
                throw err;
              }
              store.walletTxs.push({ ...vals });
            }
            return [vals];
          });
          chain.returning = () => chain;
          return chain;
        },
      };
    },
    update(table: unknown) {
      const t = tableName(table);
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              const apply = () => {
                const rows = (t === "merchant_wallets" ? store.wallets : store.walletTxs) as any[];
                const matched: any[] = [];
                // Emulate the pending-claim predicate from the sql`` chunk.
                const condStr = String((cond as any)?.queryChunks?.map((c: any) => (typeof c === "object" && c.constructor?.name === "StringChunk") ? c.value : "") ?? "");
                const requiresPending = condStr.includes("->>'status'") && condStr.includes("'pending'");
                for (const r of rows) {
                  if (!matches(r, cond)) continue;
                  if (t === "wallet_transactions" && requiresPending && r.metadata?.status !== "pending") continue;
                  Object.assign(r, vals);
                  matched.push({ ...r });
                }
                return matched;
              };
              const chain: any = thenable(apply);
              chain.returning = (fields?: Record<string, unknown>) => thenable(() =>
                apply().map((r) => (fields ? Object.fromEntries(Object.keys(fields).map((k) => [k, r[k]])) : r)));
              return chain;
            },
          };
        },
      };
    },
    // lockWalletRow: SELECT available_balance, currency ... FOR UPDATE
    async execute() {
      const w = store.wallets[0];
      return [{ available_balance: w.availableBalance, currency: w.currency }];
    },
  });

  const db: any = {
    ...makeHandle(),
    async transaction(fn: (tx: any) => Promise<any>) {
      return fn(makeHandle());
    },
  };
  return { db, store };
}

beforeEach(() => vi.clearAllMocks());

describe("wallet.rejectWithdrawal (R3)", () => {
  it("rejects a pending withdrawal and restores the balance exactly once", async () => {
    const { db, store } = makeDb({ withdrawalStatus: "pending" });
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    const res = await caller.rejectWithdrawal({ tenantId: "tenant-1", reference: "WD-REJ-1", reason: "bad account" });
    expect(res).toMatchObject({ success: true, status: "rejected", refunded: true, duplicate: false });
    // Balance restored; withdrawal flagged rejected; reversal entry recorded.
    expect(store.wallets[0].availableBalance).toBe("1000.00");
    expect(store.wallets[0].totalWithdrawn).toBe("0.00");
    expect(store.walletTxs.find((t) => t.id === "tx-wd-1")?.metadata?.status).toBe("rejected");
    const reversal = store.walletTxs.filter((t) => t.reference === "WD-REJ-1:reversal");
    expect(reversal).toHaveLength(1);
    expect(reversal[0].type).toBe("escrow_refund");
  });

  it("double-reject is an idempotent no-op (no double refund)", async () => {
    const { db, store } = makeDb({ withdrawalStatus: "pending" });
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    await caller.rejectWithdrawal({ tenantId: "tenant-1", reference: "WD-REJ-1" });
    const res2 = await caller.rejectWithdrawal({ tenantId: "tenant-1", reference: "WD-REJ-1" });
    expect(res2).toMatchObject({ success: true, status: "rejected", refunded: false, duplicate: true });
    expect(store.walletTxs.filter((t) => t.reference === "WD-REJ-1:reversal")).toHaveLength(1);
    expect(store.wallets[0].availableBalance).toBe("1000.00");
  });

  it("paid withdrawals are untouched", async () => {
    const { db, store } = makeDb({ withdrawalStatus: "paid" });
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    await expect(
      caller.rejectWithdrawal({ tenantId: "tenant-1", reference: "WD-REJ-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.wallets[0].availableBalance).toBe("500.00");
    expect(store.walletTxs.find((t) => t.id === "tx-wd-1")?.metadata?.status).toBe("paid");
    expect(store.walletTxs.filter((t) => t.reference === "WD-REJ-1:reversal")).toHaveLength(0);
  });

  it("unknown reference → NOT_FOUND", async () => {
    const { db } = makeDb({ withdrawalStatus: null });
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    await expect(
      caller.rejectWithdrawal({ tenantId: "tenant-1", reference: "WD-NOPE" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("non-admin callers are rejected", async () => {
    const { db } = makeDb({ withdrawalStatus: "pending" });
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(USER);
    await expect(
      caller.rejectWithdrawal({ tenantId: "tenant-1", reference: "WD-REJ-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
