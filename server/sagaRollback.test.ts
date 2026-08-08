/**
 * server/sagaRollback.test.ts — escrow settlement saga compensation.
 *
 * Pins compensateEscrowSettlementFailure (item: settlement saga rollback):
 * when the wallet credit throws during PSP escrow settlement AFTER the ledger
 * capture (commit of the origin payment's pending transfer), the PG
 * transaction rolls back (escrow stays not-settled) but the ledger commit
 * survives — compensation must:
 *   1. reverse the orphaned capture via /ledger/reverse (idempotent);
 *   2. keep the escrow not-settled and stamp the failure in metadata;
 *   3. flag UNCONFIRMED reversals (bridge 5xx/unreachable) for recon;
 *   4. never unsettle a genuinely settled escrow.
 * This is the helper wired into escrow.buyerConfirm and the bulk release path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Ledger-bridge client mock (capture + reversal are spied) ────────────────
const mocks = vi.hoisted(() => {
  class LedgerBridgeError extends Error {
    status: number | null;
    constructor(message: string, status: number | null = null) {
      super(message);
      this.name = "LedgerBridgeError";
      this.status = status;
    }
  }
  return {
    LedgerBridgeError,
    ledgerBridgeRequest: vi.fn(),
    reverseCommittedTransfer: vi.fn(),
  };
});

vi.mock("./services/ledgerBridge", () => ({
  LedgerBridgeError: mocks.LedgerBridgeError,
  ledgerBridgeRequest: mocks.ledgerBridgeRequest,
  reverseCommittedTransfer: mocks.reverseCommittedTransfer,
}));

import {
  escrowTransactions,
  paymentIntents,
  merchantWallets,
  walletTransactions,
  escrowConfig,
} from "../drizzle/schema";

// ─── In-memory store ─────────────────────────────────────────────────────────
const store = {
  cfg: {
    id: 1,
    custodyMode: "psp" as const,
    platformFeeRate: "0.03125",
    buyerConfirmWindowHours: 24,
    disputeWindowHours: 48,
    autoConfirmEnabled: true,
    floatYieldRate: "0.08",
    minScanConfidence: "0.70",
    updatedAt: new Date(),
  },
  escrow: {
    id: "esc-1",
    orderId: "order-1",
    tenantId: "tenant-1",
    customerId: "cust-1",
    amount: "1000.00",
    platformFee: "0.00", // fee path intentionally out of scope for this test
    netMerchantAmount: "1000.00",
    currency: "NGN",
    custodyMode: "psp",
    state: "delivery_confirmed" as string,
    metadata: {} as Record<string, unknown>,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  intent: {
    id: "pi-1",
    orderId: "order-1",
    tenantId: "tenant-1",
    status: "completed",
    ledgerPendingId: "pend-origin-1",
    completedAt: new Date(),
  },
  wallet: {
    id: "wallet-1",
    tenantId: "tenant-1",
    currency: "NGN",
    availableBalance: "0",
    escrowBalance: "1000.00",
    totalEarned: "0",
    totalWithdrawn: "0",
    custodyMode: "psp",
    isActive: true,
  },
};

let walletCreditFails = false;
const walletTxInserts: Record<string, unknown>[] = [];
const escrowUpdates: { vals: Record<string, unknown>; applied: boolean }[] = [];

/** Extract embedded JSON strings from a drizzle sql`` metadata fragment. */
function sqlText(v: unknown): string {
  try {
    const chunks = (v as any)?.queryChunks ?? [];
    return chunks.map((c: any) => {
      if (typeof c === "string") return c;
      const val = c?.value ?? c;
      return Array.isArray(val) ? val.join("") : String(val);
    }).join(" ");
  } catch {
    return String(v);
  }
}

function makeMockDb() {
  const applyEscrowUpdate = (vals: Record<string, unknown>): unknown[] => {
    let applied: boolean;
    if ("state" in vals) {
      // Claim-type guarded transition: only from releasable states.
      applied = ["delivery_confirmed", "escrow_held", "dispute_resolved"].includes(store.escrow.state);
    } else {
      // Metadata-stamp guard (compensation): never touch settled rows.
      applied = !["settled", "release_instructed"].includes(store.escrow.state);
    }
    if (applied) {
      const metaSql = vals.metadata !== undefined ? sqlText(vals.metadata) : null;
      Object.assign(store.escrow, { ...vals, metadata: metaSql ?? vals.metadata ?? store.escrow.metadata });
      escrowUpdates.push({ vals, applied });
      return [{ ...store.escrow }];
    }
    escrowUpdates.push({ vals, applied });
    return [];
  };

  const updateChain = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => ({
      where: (_cond: unknown) => {
        if (table === escrowTransactions) {
          const applied = applyEscrowUpdate(vals);
          const p = Promise.resolve(applied) as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
          p.returning = () => Promise.resolve(applied);
          return p;
        }
        // merchantWallets balance updates — always "succeed".
        const p = Promise.resolve([]) as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
        p.returning = () => Promise.resolve([store.wallet]);
        return p;
      },
    }),
  });

  const selectChain = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (_cond: unknown) => {
        const rowsFor = () => {
          if (table === escrowConfig) return [store.cfg];
          if (table === escrowTransactions) return [{ ...store.escrow }];
          if (table === paymentIntents) return [{ ledgerPendingId: store.intent.ledgerPendingId }];
          if (table === merchantWallets) return [store.wallet];
          return [];
        };
        const base = Promise.resolve(rowsFor()) as Promise<unknown[]> & Record<string, unknown>;
        base.orderBy = () => ({ limit: () => Promise.resolve(rowsFor().slice(0, 1)) });
        base.limit = () => Promise.resolve(rowsFor().slice(0, 1));
        return base;
      },
    }),
  });

  const tx = {
    select: selectChain,
    update: updateChain,
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        if (table === walletTransactions) {
          if (walletCreditFails) {
            const p = Promise.reject(new Error("wallet credit failed: connection reset")) as Promise<unknown> & Record<string, unknown>;
            p.onConflictDoNothing = () => p;
            return p;
          }
          walletTxInserts.push(vals);
        }
        const p = Promise.resolve([vals]) as Promise<unknown> & Record<string, unknown>;
        p.onConflictDoNothing = () => Promise.resolve([]);
        p.returning = () => Promise.resolve([vals]);
        return p;
      },
    }),
    execute: (_q: unknown) => Promise.resolve([{ available_balance: store.wallet.availableBalance, currency: "NGN" }]),
  };

  return {
    ...tx,
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
      // PG semantics: any throw rolls the whole transaction back.
      const snapshot = { escrow: { ...store.escrow }, wallet: { ...store.wallet } };
      const insertCount = walletTxInserts.length;
      try {
        return await cb(tx);
      } catch (err) {
        store.escrow = snapshot.escrow;
        store.wallet = snapshot.wallet;
        walletTxInserts.length = insertCount;
        throw err;
      }
    },
  };
}

const {
  settleEscrowAtomic,
  compensateEscrowSettlementFailure,
  EscrowSettlementError,
} = await import("./routers/escrow");

function reset() {
  store.escrow.state = "delivery_confirmed";
  store.escrow.metadata = {};
  walletCreditFails = false;
  walletTxInserts.length = 0;
  escrowUpdates.length = 0;
  mocks.ledgerBridgeRequest.mockReset();
  mocks.reverseCommittedTransfer.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("settleEscrowAtomic — ledger capture + saga error surface", () => {
  beforeEach(reset);

  it("happy path: capture commits, wallet credited, escrow settled", async () => {
    mocks.ledgerBridgeRequest.mockResolvedValue({ status: "committed" });
    const db = makeMockDb();
    const result = await settleEscrowAtomic(db as any, "esc-1", {
      autoConfirmed: false,
      allowedFromStates: ["delivery_confirmed"],
    });
    expect(result.transitioned).toBe(true);
    expect(result.newState).toBe("settled");
    // Capture = commit of the origin payment's pending transfer.
    expect(mocks.ledgerBridgeRequest).toHaveBeenCalledWith("/ledger/commit", "POST", { pending_id: "pend-origin-1" });
    expect(walletTxInserts.length).toBe(1);
    expect(store.escrow.state).toBe("settled");
  });

  it("wallet credit throws AFTER capture → EscrowSettlementError carrying captured ids; PG rolls back", async () => {
    mocks.ledgerBridgeRequest.mockResolvedValue({ status: "committed" });
    walletCreditFails = true;
    const db = makeMockDb();

    const err = await settleEscrowAtomic(db as any, "esc-1", {
      autoConfirmed: false,
      allowedFromStates: ["delivery_confirmed"],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(EscrowSettlementError);
    expect((err as InstanceType<typeof EscrowSettlementError>).capturedPendingIds).toEqual(["pend-origin-1"]);
    // PG rollback: escrow NOT settled, wallet tx rolled back.
    expect(store.escrow.state).toBe("delivery_confirmed");
    expect(walletTxInserts.length).toBe(0);
  });

  it("capture already committed (400) is a tolerated no-op; settlement proceeds", async () => {
    mocks.ledgerBridgeRequest.mockRejectedValue(new mocks.LedgerBridgeError("already committed", 400));
    const db = makeMockDb();
    const result = await settleEscrowAtomic(db as any, "esc-1", {
      autoConfirmed: false,
      allowedFromStates: ["delivery_confirmed"],
    });
    expect(result.transitioned).toBe(true);
    expect(store.escrow.state).toBe("settled");
  });

  it("ledger outage during capture (503) aborts settlement with NO compensation needed", async () => {
    mocks.ledgerBridgeRequest.mockRejectedValue(new mocks.LedgerBridgeError("ledger unavailable", 503));
    const db = makeMockDb();
    const err = await settleEscrowAtomic(db as any, "esc-1", {
      autoConfirmed: false,
      allowedFromStates: ["delivery_confirmed"],
    }).catch((e) => e);
    // Nothing captured → plain error, NOT EscrowSettlementError.
    expect(err).not.toBeInstanceOf(EscrowSettlementError);
    expect(err.status).toBe(503);
    expect(store.escrow.state).toBe("delivery_confirmed");
  });
});

describe("compensateEscrowSettlementFailure — reversal + recon flagging", () => {
  beforeEach(reset);

  it("reverses the orphaned capture (idempotent /ledger/reverse) and stamps the escrow not-settled", async () => {
    mocks.reverseCommittedTransfer.mockResolvedValue({ status: "reversed", reversal_id: "rev-1" });
    const db = makeMockDb();
    const out = await compensateEscrowSettlementFailure(db as any, {
      escrowId: "esc-1",
      pendingIds: ["pend-origin-1"],
      reason: "escrow settlement failed after ledger capture: wallet credit failed",
    });

    expect(mocks.reverseCommittedTransfer).toHaveBeenCalledWith("pend-origin-1", "escrow-settlement-failure:esc-1");
    expect(out.reversedPendingIds).toEqual(["pend-origin-1"]);
    expect(out.unconfirmedPendingIds).toEqual([]);
    expect(out.escrowFlagged).toBe(true);
    // Escrow remains not-settled; failure stamped in metadata for audit/recon.
    expect(store.escrow.state).toBe("delivery_confirmed");
    expect(String(store.escrow.metadata)).toContain("settlementFailure");
    expect(String(store.escrow.metadata)).toContain("pend-origin-1");
  });

  it("bridge unreachable during reversal → unconfirmed reversal FLAGGED for recon", async () => {
    mocks.reverseCommittedTransfer.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const db = makeMockDb();
    const out = await compensateEscrowSettlementFailure(db as any, {
      escrowId: "esc-1",
      pendingIds: ["pend-origin-1"],
      reason: "wallet credit failed",
    });

    expect(out.reversedPendingIds).toEqual([]);
    expect(out.unconfirmedPendingIds).toEqual(["pend-origin-1"]);
    expect(out.escrowFlagged).toBe(true);
    expect(String(store.escrow.metadata)).toContain('"reconRequired":true');
    expect(String(store.escrow.metadata)).toContain("unconfirmedReversalPendingIds");
  });

  it("never unsettles a genuinely settled escrow — escalates instead", async () => {
    store.escrow.state = "settled";
    mocks.reverseCommittedTransfer.mockResolvedValue({ status: "reversed" });
    const db = makeMockDb();
    const out = await compensateEscrowSettlementFailure(db as any, {
      escrowId: "esc-1",
      pendingIds: ["pend-origin-1"],
      reason: "wallet credit failed",
    });
    expect(out.escrowFlagged).toBe(false);
    expect(store.escrow.state).toBe("settled"); // untouched
    expect(console.error).toHaveBeenCalled();
  });
});

describe("buyerConfirm / bulk-release wiring (composed path)", () => {
  beforeEach(reset);

  it("settlement failure after capture is compensated end-to-end", async () => {
    // Simulate exactly what the buyerConfirm catch does:
    // settleEscrowAtomic throws EscrowSettlementError → compensate.
    mocks.ledgerBridgeRequest.mockResolvedValue({ status: "committed" });
    mocks.reverseCommittedTransfer.mockResolvedValue({ status: "reversed" });
    walletCreditFails = true;
    const db = makeMockDb();

    const settleErr = await settleEscrowAtomic(db as any, "esc-1", {
      autoConfirmed: false,
      allowedFromStates: ["delivery_confirmed"],
    }).catch((e) => e);
    expect(settleErr).toBeInstanceOf(EscrowSettlementError);

    const out = await compensateEscrowSettlementFailure(db as any, {
      escrowId: "esc-1",
      pendingIds: (settleErr as InstanceType<typeof EscrowSettlementError>).capturedPendingIds,
      reason: (settleErr as Error).message,
    });

    expect(out.reversedPendingIds).toEqual(["pend-origin-1"]);
    expect(store.escrow.state).toBe("delivery_confirmed");
    expect(String(store.escrow.metadata)).toContain("settlementFailure");
  });
});
