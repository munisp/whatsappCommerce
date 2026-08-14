/**
 * A1-03 regression: concurrent same-reference withdrawals must debit ONCE.
 *
 * Pre-fix: requestWithdrawal's idempotency check (`select ... where
 * reference = $ref`) ran OUTSIDE the debit transaction and
 * wallet_transactions had no unique index on (wallet_id, reference) — two
 * concurrent same-reference calls both passed the check and both executed
 * the atomic conditional debit (double debit of available balance).
 *
 * Post-fix layers under test:
 *   (a) the reference re-check moved INSIDE the debit transaction;
 *   (b) partial unique index wallet_tx_wallet_ref_uniq (0053) — emulated
 *       here with PG 23505 semantics;
 *   (c) 23505 translated into an idempotent replay of the original pending
 *       withdrawal ({ duplicate: true }), never a second debit.
 *
 * The fake db below emulates two INTERLEAVED transactions (real PG
 * READ-COMMITTED style: both in-tx re-checks run before either insert
 * commits) with per-transaction undo on rollback — this is exactly the
 * interleaving that defeats a read-then-check outside the tx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./routers/audit", () => ({ writeAuditLog: vi.fn(async () => {}) }));

import { getDb } from "./db";
import { walletRouter } from "./routers/escrow";
import { escrowConfig, merchantWallets, walletTransactions } from "../drizzle/schema";

const ADMIN = { user: { id: "u-admin", role: "admin", tenantId: null } } as any;

// ── Narrow drizzle-condition decode (eq/and: columns pair with values) ──────
function decode(cond: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (c: unknown): void => {
    if (c == null) return;
    if (Array.isArray(c)) return c.forEach(walk);
    const t = typeof c;
    if (t === "string" || t === "number" || t === "boolean" || c instanceof Date) { values.push(c); return; }
    if (t !== "object") return;
    const o = c as Record<string, any>;
    if (o.constructor?.name === "StringChunk") return;
    if (o.constructor?.name === "Column" || (typeof o.name === "string" && o.table != null)) { columns.push(o.name); return; }
    if (Array.isArray(o.queryChunks)) return walk(o.queryChunks);
    if ("value" in o) { values.push(o.value); return; }
  };
  walk((cond as any)?.queryChunks ?? cond);
  return { columns, values };
}

const PROP: Record<string, Record<string, string>> = {
  escrow_config: { id: "id" },
  merchant_wallets: { id: "id", tenant_id: "tenantId" },
  wallet_transactions: { wallet_id: "walletId", reference: "reference", id: "id" },
};

interface WalletRow { id: string; tenantId: string; currency: string; availableBalance: string; totalWithdrawn: string; [k: string]: unknown }
interface TxRow { id: string; walletId: string; tenantId: string; type: string; amount: string; reference: string | null; metadata: any; [k: string]: unknown }

function makeWalletDb() {
  const store = {
    config: [{ id: 1, custodyMode: "psp", platformFeeRate: "0.03125", buyerConfirmWindowHours: 24, disputeWindowHours: 48, autoConfirmEnabled: true, floatYieldRate: "0.08", updatedAt: new Date() }],
    wallets: [{
      id: "wal-1", tenantId: "tenant-1", currency: "NGN",
      availableBalance: "1000.00", escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: new Date(), updatedAt: new Date(),
    }] as WalletRow[],
    walletTxs: [] as TxRow[],
  };
  const tableName = (table: unknown): string => {
    if (table === escrowConfig) return "escrow_config";
    if (table === merchantWallets) return "merchant_wallets";
    if (table === walletTransactions) return "wallet_transactions";
    throw new Error("fake db: unknown table");
  };
  const rowsOf = (t: string): any[] =>
    t === "escrow_config" ? store.config : t === "merchant_wallets" ? store.wallets : store.walletTxs;

  function runSelect(t: string, fields: Record<string, unknown> | undefined, cond: unknown) {
    const { columns, values } = decode(cond);
    let rows = rowsOf(t).filter((r) => columns.every((c, i) => r[PROP[t][c] ?? c] === values[i]));
    if (fields) rows = rows.map((r) => Object.fromEntries(Object.keys(fields).map((k) => [k, r[k]])));
    return rows.map((r) => ({ ...r }));
  }

  /** Collect bound params from a raw sql`` template in order. */
  function sqlParams(q: unknown): unknown[] {
    const out: unknown[] = [];
    const walk = (c: unknown): void => {
      if (c == null) return;
      if (Array.isArray(c)) return c.forEach(walk);
      // Bare primitives ARE the bound params (StringChunk text is an object).
      if (typeof c === "string" || typeof c === "number" || typeof c === "boolean" || c instanceof Date) {
        out.push(c); return;
      }
      const o = c as any;
      if (typeof o !== "object") return;
      if (o.constructor?.name === "StringChunk") return;
      if (Array.isArray(o.queryChunks)) return walk(o.queryChunks);
      if ("value" in o && typeof o.value !== "object") { out.push(o.value); return; }
    };
    walk((q as any)?.queryChunks ?? q);
    return out;
  }

  function insertWalletTx(v: any, undo?: () => void) {
    // 0053 partial unique index wallet_tx_wallet_ref_uniq (wallet_id, reference)
    if (v.reference != null &&
        store.walletTxs.some((r) => r.walletId === v.walletId && r.reference === v.reference)) {
      const err: any = new Error(`duplicate key value violates unique constraint "wallet_tx_wallet_ref_uniq"`);
      err.code = "23505";
      err.constraint = "wallet_tx_wallet_ref_uniq";
      throw err;
    }
    store.walletTxs.push({ ...v });
  }

  const thenable = (get: () => any) => {
    const self: any = {};
    self.then = (res: (v: any) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(get).then(res, rej);
    self.catch = (rej: (e: unknown) => unknown) => Promise.resolve().then(get).catch(rej);
    return self;
  };

  const makeHandle = (undo: Array<() => void> | null): any => ({
    select(fields?: Record<string, unknown>) {
      return { from(table: unknown) { const t = tableName(table); return { where(cond: unknown) { return thenable(() => runSelect(t, fields, cond)); } }; } };
    },
    insert(table: unknown) {
      const t = tableName(table);
      return {
        values(vals: any) {
          const get = () => {
            if (t === "wallet_transactions") {
              insertWalletTx(vals);
              undo?.push(() => { store.walletTxs = store.walletTxs.filter((r) => r.id !== vals.id); });
            } else if (t === "merchant_wallets") {
              store.wallets.push({ ...vals });
            }
            return [vals];
          };
          const chain: any = thenable(get);
          chain.returning = () => chain;
          chain.onConflictDoNothing = () => chain;
          return chain;
        },
      };
    },
    update(table: unknown) {
      const t = tableName(table);
      return { set(vals: Record<string, unknown>) { return { where(cond: unknown) {
        return thenable(() => {
          const { columns, values } = decode(cond);
          const matched: any[] = [];
          for (const r of rowsOf(t)) {
            if (!columns.every((c, i) => r[PROP[t][c] ?? c] === values[i])) continue;
            Object.assign(r, vals);
            matched.push({ ...r });
          }
          return matched;
        });
      } }; } };
    },
    // Atomic conditional debit (raw SQL in requestWithdrawal).
    async execute(q: unknown) {
      const [amt, , walletId] = sqlParams(q) as [string, string, string];
      const w = store.wallets.find((r) => r.id === walletId);
      if (!w) return [];
      const amount = parseFloat(amt);
      if (parseFloat(w.availableBalance) < amount) return [];
      const prev = { availableBalance: w.availableBalance, totalWithdrawn: w.totalWithdrawn };
      undo?.push(() => Object.assign(w, prev));
      w.availableBalance = (parseFloat(w.availableBalance) - amount).toFixed(2);
      w.totalWithdrawn = (parseFloat(w.totalWithdrawn) + amount).toFixed(2);
      return [{ available_balance: w.availableBalance }];
    },
  });

  const db: any = {
    ...makeHandle(null),
    // Interleaved transactions with per-tx undo (PG READ-COMMITTED analogue):
    // both transactions' statements run against the shared store; a failing
    // tx rolls back ONLY its own writes.
    async transaction(fn: (tx: any) => Promise<any>) {
      const undo: Array<() => void> = [];
      try {
        return await fn(makeHandle(undo));
      } catch (err) {
        for (const u of undo.reverse()) u();
        throw err;
      }
    },
  };
  return { db, store };
}

beforeEach(() => vi.clearAllMocks());

describe("wallet.requestWithdrawal — same-reference double-debit race (A1-03)", () => {
  it("two concurrent same-reference withdrawals debit EXACTLY ONCE", async () => {
    const { db, store } = makeWalletDb();
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    const [r1, r2] = await Promise.all([
      caller.requestWithdrawal({ tenantId: "tenant-1", amount: 500, reference: "WD-RACE-1" }),
      caller.requestWithdrawal({ tenantId: "tenant-1", amount: 500, reference: "WD-RACE-1" }),
    ]);
    const results = [r1, r2];
    // Exactly one withdrawal row, one debit of 500.
    expect(store.walletTxs.filter((t) => t.reference === "WD-RACE-1")).toHaveLength(1);
    expect(store.wallets[0].availableBalance).toBe("500.00");
    expect(store.wallets[0].totalWithdrawn).toBe("500.00");
    // One fresh request, one idempotent replay — neither threw.
    const dup = results.filter((r) => r.duplicate === true);
    const fresh = results.filter((r) => r.duplicate === false);
    expect(fresh).toHaveLength(1);
    expect(dup).toHaveLength(1);
    expect(dup[0].amount).toBe(500);
    expect(dup[0].status).toBe("pending");
  });

  it("sequential same-reference retry replays the original withdrawal (no second debit)", async () => {
    const { db, store } = makeWalletDb();
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    const first = await caller.requestWithdrawal({ tenantId: "tenant-1", amount: 400, reference: "WD-SEQ-1" });
    const second = await caller.requestWithdrawal({ tenantId: "tenant-1", amount: 400, reference: "WD-SEQ-1" });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(store.walletTxs).toHaveLength(1);
    expect(store.wallets[0].availableBalance).toBe("600.00");
  });

  it("over-balance withdrawal is refused and never recorded", async () => {
    const { db, store } = makeWalletDb();
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    await expect(
      caller.requestWithdrawal({ tenantId: "tenant-1", amount: 5000, reference: "WD-BIG" }),
    ).rejects.toThrow(/INSUFFICIENT_FUNDS/);
    expect(store.walletTxs).toHaveLength(0);
    expect(store.wallets[0].availableBalance).toBe("1000.00");
  });

  it("distinct references each debit independently", async () => {
    const { db, store } = makeWalletDb();
    (getDb as any).mockResolvedValue(db);
    const caller = walletRouter.createCaller(ADMIN);
    await caller.requestWithdrawal({ tenantId: "tenant-1", amount: 100, reference: "WD-A" });
    await caller.requestWithdrawal({ tenantId: "tenant-1", amount: 200, reference: "WD-B" });
    expect(store.walletTxs).toHaveLength(2);
    expect(store.wallets[0].availableBalance).toBe("700.00");
  });
});
