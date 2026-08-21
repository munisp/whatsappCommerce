/**
 * server/escrowOrdersFixes.test.ts — regression coverage for audit findings
 * F5/F7/F12/F13 + COD hardening (Coder B, branch w26/escrow-orders):
 *
 *   F5  settleEscrowAtomic is remainder-aware: after a partial refund the
 *       wallet release is (net − alreadyRefunded), never the full stored net.
 *   F7  finalizeWalletWithdrawal reconciles contradictions: a
 *       transfer.success webhook against an already-refunded ("failed") row
 *       is flagged needsReconciliation, never silently swallowed.
 *       verifyTransfer (Paystack /transfer/verify) drives the
 *       timeout double-spend guard in requestWithdrawal.
 *   F12 isLegalOrderTransition enforces the order status state machine.
 *   COD confirmCashCollection caps collections at the order total and its
 *       deterministic idempotency key no longer collapses two distinct
 *       partial collections of the same amount.
 *
 * Router-level coverage still needed in Coder D's escrow.test.ts (noted in
 * the cross-coder report): duplicate createHold retry, withdrawal timeout
 * path, orderCrud over-refund rejection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  escrowTransactions,
  escrowConfig,
  paymentIntents,
  merchantWallets,
  walletTransactions,
  orders,
  paymentTransactions,
  codEvents,
} from "../drizzle/schema";

const { settleEscrowAtomic, finalizeWalletWithdrawal } = await import("./routers/escrow");
const { isLegalOrderTransition } = await import("./routers/orderCrud");
const { confirmCashCollection } = await import("./services/codFlow");

// ─── F5: settleEscrowAtomic remainder-aware release ──────────────────────────

function makeEscrowMockDb(escrow: Record<string, any>, cfg: Record<string, any>) {
  const walletTxInserts: Record<string, any>[] = [];
  const wallet = {
    id: "wallet-1", tenantId: escrow.tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: escrow.amount, totalEarned: "0",
    totalWithdrawn: "0", custodyMode: "psp", isActive: true,
  };
  const selectChain = () => ({
    from: (table: unknown) => ({
      where: (_c: unknown) => {
        const rows = () => {
          if (table === escrowConfig) return [cfg];
          if (table === paymentIntents) return [{ ledgerPendingId: null }];
          if (table === merchantWallets) return [wallet];
          return [];
        };
        const base = Promise.resolve(rows()) as Promise<any[]> & Record<string, any>;
        base.orderBy = () => ({ limit: () => Promise.resolve(rows().slice(0, 1)) });
        base.limit = () => Promise.resolve(rows().slice(0, 1));
        return base;
      },
    }),
  });
  const tx: any = {
    select: selectChain,
    execute: () => Promise.resolve([{ available_balance: wallet.availableBalance, currency: "NGN" }]),
    insert: (table: unknown) => ({
      values: (vals: Record<string, any>) => {
        if (table === walletTransactions) walletTxInserts.push(vals);
        const p = Promise.resolve([vals]) as Promise<any> & Record<string, any>;
        p.onConflictDoNothing = () => p;
        p.returning = () => Promise.resolve([vals]);
        return p;
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, any>) => ({
        where: (_c: unknown) => {
          let applied: any[] = [];
          if (table === escrowTransactions && "state" in vals) {
            // claim guard: only from allowed pre-settlement states
            if (["delivery_confirmed", "escrow_held", "dispute_resolved"].includes(escrow.state)) {
              Object.assign(escrow, vals);
              applied = [{ ...escrow }];
            }
          } else if (table === escrowTransactions) {
            Object.assign(escrow, vals);
            applied = [{ ...escrow }];
          }
          const p = Promise.resolve(applied) as Promise<any[]> & Record<string, any>;
          p.returning = () => Promise.resolve(applied);
          return p;
        },
      }),
    }),
  };
  const db = { ...tx, transaction: async (cb: any) => cb(tx) };
  return { db, walletTxInserts };
}

describe("F5: settleEscrowAtomic — remainder-aware release after partial refund", () => {
  const cfg = { id: 1, custodyMode: "psp", platformFeeRate: "0" };

  it("no refund: releases the full stored net", async () => {
    const escrow = {
      id: "esc-1", orderId: "o-1", tenantId: "t-1",
      amount: "1000.00", platformFee: "0.00", netMerchantAmount: "1000.00",
      state: "delivery_confirmed", metadata: {},
    };
    const { db, walletTxInserts } = makeEscrowMockDb(escrow, cfg);
    const res = await settleEscrowAtomic(db as any, "esc-1", { autoConfirmed: false, allowedFromStates: ["delivery_confirmed"] });
    expect(res.transitioned).toBe(true);
    const release = walletTxInserts.find((r) => r.type === "escrow_release");
    expect(release?.amount).toBe("1000.00");
  });

  it("partial refund: releases only (net − alreadyRefunded), never the full net", async () => {
    const escrow = {
      id: "esc-2", orderId: "o-2", tenantId: "t-1",
      amount: "1000.00", platformFee: "0.00", netMerchantAmount: "1000.00",
      state: "delivery_confirmed", metadata: { refundedAmount: "400.00" },
    };
    const { db, walletTxInserts } = makeEscrowMockDb(escrow, cfg);
    const res = await settleEscrowAtomic(db as any, "esc-2", { autoConfirmed: false, allowedFromStates: ["delivery_confirmed"] });
    expect(res.transitioned).toBe(true);
    const release = walletTxInserts.find((r) => r.type === "escrow_release");
    expect(release?.amount).toBe("600.00");
  });

  it("refund consumed the whole net: no release row, fee capped at held remainder", async () => {
    const escrow = {
      id: "esc-3", orderId: "o-3", tenantId: "t-1",
      amount: "1000.00", platformFee: "50.00", netMerchantAmount: "950.00",
      state: "delivery_confirmed", metadata: { refundedAmount: "975.00" },
    };
    const { db, walletTxInserts } = makeEscrowMockDb(escrow, cfg);
    const res = await settleEscrowAtomic(db as any, "esc-3", { autoConfirmed: false, allowedFromStates: ["delivery_confirmed"] });
    expect(res.transitioned).toBe(true);
    expect(walletTxInserts.find((r) => r.type === "escrow_release")).toBeUndefined();
    const fee = walletTxInserts.find((r) => r.type === "fee_deduction");
    expect(fee?.amount).toBe("25.00"); // held remainder = 1000 − 975
  });
});

// ─── F7: finalizeWalletWithdrawal reconciliation ─────────────────────────────

function makeWithdrawalMockDb(row: Record<string, any>) {
  const executes: any[] = [];
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }),
      }),
    }),
    execute: (q: any) => {
      executes.push(q);
      // claim-style guarded UPDATEs succeed (one row claimed)
      return Promise.resolve([{ id: row?.id ?? "wtx-1" }]);
    },
  };
  return { db, executes };
}

describe("F7: finalizeWalletWithdrawal — contradiction reconciliation", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("transfer.success against an already-refunded row is flagged, not swallowed", async () => {
    const row = { id: "wtx-1", walletId: "wallet-1", amount: "500.00", metadata: { status: "failed" } };
    const { db, executes } = makeWithdrawalMockDb(row);
    const res = await finalizeWalletWithdrawal(db, { reference: "ref-1", event: "transfer.success", reason: null });
    expect(res.action).toBe("conflict-flagged");
    expect(res.ok).toBe(false);
    expect(executes.length).toBe(1); // needsReconciliation flag written, NO balance credit
  });

  it("matching terminal webhook stays an idempotent no-op", async () => {
    const row = { id: "wtx-1", walletId: "wallet-1", amount: "500.00", metadata: { status: "failed" } };
    const { db, executes } = makeWithdrawalMockDb(row);
    const res = await finalizeWalletWithdrawal(db, { reference: "ref-1", event: "transfer.failed", reason: "x" });
    expect(res.action).toBe("already-terminal");
    expect(executes.length).toBe(0);
  });

  it("in-flight row + transfer.success → completed claim", async () => {
    const row = { id: "wtx-1", walletId: "wallet-1", amount: "500.00", metadata: { status: "processing" } };
    const { db } = makeWithdrawalMockDb(row);
    const res = await finalizeWalletWithdrawal(db, { reference: "ref-1", event: "transfer.success", reason: null });
    expect(res.action).toBe("completed");
  });
});

// ─── F7: verifyTransfer (timeout double-spend guard primitive) ───────────────

describe("F7: verifyTransfer — Paystack transfer status lookup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns found + status when Paystack knows the reference", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({ status: true, data: { status: "pending", transfer_code: "TRF_x" } })),
    }));
    const { verifyTransfer } = await import("./services/payments/paystackTransfer");
    const res = await verifyTransfer("sk", "ref-1");
    expect(res).toEqual({ status: "pending", transferCode: "TRF_x", found: true });
  });

  it("returns found:false when Paystack reports the transfer unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400,
      text: () => Promise.resolve(JSON.stringify({ status: false, message: "Transfer not found" })),
    }));
    const { verifyTransfer } = await import("./services/payments/paystackTransfer");
    const res = await verifyTransfer("sk", "ref-unknown");
    expect(res.found).toBe(false);
  });
});

// ─── F12: order status state machine ─────────────────────────────────────────

describe("F12: isLegalOrderTransition", () => {
  it("allows the happy path", () => {
    expect(isLegalOrderTransition("pending", "confirmed")).toBe(true);
    expect(isLegalOrderTransition("confirmed", "processing")).toBe(true);
    expect(isLegalOrderTransition("processing", "shipped")).toBe(true);
    expect(isLegalOrderTransition("shipped", "delivered")).toBe(true);
    expect(isLegalOrderTransition("delivered", "refunded")).toBe(true);
  });

  it("allows cancellation only from pre-fulfilled states", () => {
    expect(isLegalOrderTransition("pending", "cancelled")).toBe(true);
    expect(isLegalOrderTransition("processing", "cancelled")).toBe(true);
    expect(isLegalOrderTransition("shipped", "cancelled")).toBe(false);
    expect(isLegalOrderTransition("delivered", "cancelled")).toBe(false);
  });

  it("rejects backwards / terminal-escape transitions", () => {
    expect(isLegalOrderTransition("delivered", "pending")).toBe(false);
    expect(isLegalOrderTransition("cancelled", "shipped")).toBe(false);
    expect(isLegalOrderTransition("refunded", "pending")).toBe(false);
    expect(isLegalOrderTransition("pending", "delivered")).toBe(false);
    expect(isLegalOrderTransition("pending", "refunded")).toBe(false);
  });
});

// ─── COD: over-collection cap + collision-safe idempotency ───────────────────

function makeCodMockDb(order: Record<string, any>) {
  const payments: Record<string, any>[] = [];
  const seenRefs = new Set<string>();
  const db: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: (_c: unknown) => {
          const rows = () => {
            if (table === orders) return [{ ...order }];
            if (table === paymentTransactions) {
              return payments.filter((p) => p.status === "completed");
            }
            return [];
          };
          const base = Promise.resolve(rows()) as Promise<any[]> & Record<string, any>;
          base.limit = () => Promise.resolve(rows().slice(0, 1));
          base.orderBy = () => Promise.resolve(rows());
          return base;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, any>) => {
        if (table === paymentTransactions) {
          const dup = seenRefs.has(String(vals.providerRef));
          const p = Promise.resolve(dup ? [] : [vals]) as Promise<any> & Record<string, any>;
          if (!dup) { seenRefs.add(String(vals.providerRef)); payments.push(vals); }
          p.onConflictDoNothing = () => ({ returning: () => Promise.resolve(dup ? [] : [{ id: vals.id }]) });
          p.returning = () => Promise.resolve([vals]);
          return p;
        }
        // codEvents claim / merchantNotifications
        const p = Promise.resolve([vals]) as Promise<any> & Record<string, any>;
        p.onConflictDoNothing = () => ({ returning: () => Promise.resolve([{ id: vals.id ?? "ev-1" }]) });
        p.returning = () => Promise.resolve([vals]);
        return p;
      },
    }),
    update: () => ({
      set: (vals: Record<string, any>) => ({
        where: () => {
          Object.assign(order, vals);
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { db, payments, seenRefs };
}

describe("COD: confirmCashCollection cap + idempotency", () => {
  const baseOrder = () => ({
    id: "o-1", tenantId: "t-1", customerId: "c-1", orderNumber: "ORD-1",
    totalAmount: "500.00", currency: "NGN", codState: "delivered_pending_cash",
    paymentStatus: "unpaid",
  });

  it("caps an over-tendered collection at the remaining order total", async () => {
    const order = baseOrder();
    const { db, payments } = makeCodMockDb(order);
    const res = await confirmCashCollection(db, { tenantId: "t-1", orderId: "o-1", amount: 700, actor: "rider" });
    expect(res.applied).toBe(true);
    expect(payments[0].amount).toBe("500.00"); // clamped from 700
    expect(res.summary.totalPaid).toBe(500);
    expect(res.completed).toBe(true);
  });

  it("two distinct partial collections of the SAME amount no longer collide", async () => {
    const order = baseOrder();
    const { db, payments } = makeCodMockDb(order);
    const r1 = await confirmCashCollection(db, { tenantId: "t-1", orderId: "o-1", amount: 200, actor: "rider" });
    const r2 = await confirmCashCollection(db, { tenantId: "t-1", orderId: "o-1", amount: 200, actor: "rider" });
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true); // was a false "replay" with the old key
    expect(payments.length).toBe(2);
    expect(new Set(payments.map((p) => p.providerRef)).size).toBe(2);
    // third collection capped at remaining 100
    const r3 = await confirmCashCollection(db, { tenantId: "t-1", orderId: "o-1", amount: 200, actor: "rider" });
    expect(r3.applied).toBe(true);
    expect(payments[2].amount).toBe("100.00");
    expect(r3.summary.totalPaid).toBe(500);
  });

  it("an explicit idempotency-key replay is still a no-op", async () => {
    const order = baseOrder();
    const { db, payments } = makeCodMockDb(order);
    const key = "rider-app:conf-123";
    await confirmCashCollection(db, { tenantId: "t-1", orderId: "o-1", amount: 200, actor: "rider", idempotencyKey: key });
    const replay = await confirmCashCollection(db, { tenantId: "t-1", orderId: "o-1", amount: 200, actor: "rider", idempotencyKey: key });
    expect(replay.applied).toBe(false);
    expect(payments.length).toBe(1);
  });
});
