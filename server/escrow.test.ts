/**
 * Escrow unit tests — rewritten (F14) to exercise the REAL escrow code paths
 * in server/routers/escrow.ts (settleEscrowAtomic / refundEscrowAtomic) and
 * the REAL fee split in shared/escrowAmounts.ts against an embedded Postgres
 * (PGlite) running the full drizzle migration chain.
 *
 * The previous version tested a shadow copy of the state machine (duplicated
 * `nextStateOn*` helpers) that could drift from production logic unnoticed.
 * Here only the OUT OF PROCESS collaborators are mocked (ledger bridge HTTP,
 * notifications, storage, audit) — all DB reads/writes, guarded state
 * transitions, wallet ledger entries and fee math are the production code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import net from "net";
import crypto from "crypto";

process.env.NODE_ENV = "test";
process.env.TZ = "UTC";

// ─── Mock only out-of-process collaborators (NOT the DB layer) ───────────────
const ledgerBridgeRequest = vi.fn(async () => ({}));
vi.mock("./services/ledgerBridge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/ledgerBridge")>();
  return {
    ...orig,
    ledgerBridgeRequest: (...args: unknown[]) => ledgerBridgeRequest(...args),
    reverseCommittedTransfer: vi.fn(async () => ({})),
  };
});
vi.mock("./storage", () => ({ storagePut: vi.fn(), storageGet: vi.fn() }));
vi.mock("./routers/notifications", () => ({
  emitNotification: vi.fn(async () => ({})),
  NOTIFICATION_TEMPLATES: {},
}));
vi.mock("./_core/notification", () => ({ notifyOwner: vi.fn(async () => true) }));
vi.mock("./routers/audit", () => ({ writeAuditLog: vi.fn(async () => ({})) }));
vi.mock("./services/disputes", () => ({ raiseEscrowDispute: vi.fn(async () => ({})) }));

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../drizzle/schema";
import { splitEscrowAmounts } from "../shared/escrowAmounts";

type Db = ReturnType<typeof drizzle>;

let pg: PGlite;
let pgServer: PGLiteSocketServer;
let client: ReturnType<typeof postgres>;
let db: Db;
let settleEscrowAtomic: typeof import("./routers/escrow").settleEscrowAtomic;
let refundEscrowAtomic: typeof import("./routers/escrow").refundEscrowAtomic;
let PLATFORM_FEE_WALLET_ID: string;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  const migDir = path.resolve(process.cwd(), "drizzle");
  const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of migFiles) {
    const sqlText = fs.readFileSync(path.join(migDir, f), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await pg.exec(stmt);
    }
  }
  const port = await freePort();
  pgServer = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
  await pgServer.start();
  client = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  db = drizzle(client);

  const mod = await import("./routers/escrow");
  settleEscrowAtomic = mod.settleEscrowAtomic;
  refundEscrowAtomic = mod.refundEscrowAtomic;
  PLATFORM_FEE_WALLET_ID = mod.PLATFORM_FEE_WALLET_ID;
}, 120_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  await pgServer?.stop().catch(() => {});
  await pg?.close().catch(() => {});
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────
const TENANT = "escrow-test-tenant";
let orderSeq = 0;

async function setConfig(custodyMode: "pssp" | "psp") {
  await db.delete(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1));
  await db.insert(schema.escrowConfig).values({
    id: 1,
    custodyMode,
    platformFeeRate: "0.03125",
    buyerConfirmWindowHours: 24,
    disputeWindowHours: 48,
    autoConfirmEnabled: true,
    floatYieldRate: "0.08",
    updatedAt: new Date(),
  });
}

async function seedEscrow(opts: { state: string; amount: string; fee: string; net: string; custodyMode?: "pssp" | "psp" }) {
  const customerId = crypto.randomUUID();
  await db.insert(schema.customers).values({
    id: customerId,
    tenantId: TENANT,
    whatsappPhone: `23480${String(++orderSeq).padStart(8, "0")}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const orderId = crypto.randomUUID();
  await db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT,
    customerId,
    orderNumber: `ESC-TEST-${orderSeq}`,
    totalAmount: opts.amount,
    currency: "NGN",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const escrowId = crypto.randomUUID();
  await db.insert(schema.escrowTransactions).values({
    id: escrowId,
    orderId,
    tenantId: TENANT,
    customerId,
    amount: opts.amount,
    platformFee: opts.fee,
    netMerchantAmount: opts.net,
    currency: "NGN",
    custodyMode: opts.custodyMode ?? "psp",
    state: opts.state as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { escrowId, orderId, customerId };
}

async function walletOf(tenantId: string) {
  const [w] = await db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
  return w;
}

async function walletTxs(walletId: string) {
  return db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.walletId, walletId));
}

// ─── Real fee split (shared/escrowAmounts) ────────────────────────────────────
describe("splitEscrowAmounts (shared/escrowAmounts.ts)", () => {
  it("conserves fee + net == gross for a deterministic sweep of amounts", () => {
    // Deterministic pseudo-random sweep (LCG) — no unseeded Math.random.
    let s = 0x5eed;
    const next = () => (s = (s * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      const grossMinor = 1 + (next() % 10_000_000);
      const split = splitEscrowAmounts(grossMinor / 100, 0.03125);
      expect(split.feeMinor + split.netMinor).toBe(split.grossMinor);
      expect(split.feeMinor).toBeGreaterThanOrEqual(0);
      expect(split.netMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it("rounds the fee exactly once (half up)", () => {
    const split = splitEscrowAmounts("10000.00", 0.03125);
    expect(split.fee).toBe("312.50");
    expect(split.net).toBe("9687.50");
  });
});

// ─── Real settlement path: PSP custody (wallet credit) ────────────────────────
describe("settleEscrowAtomic — PSP custody (real code, PGlite)", () => {
  it("settles escrow_held → settled, credits net to merchant, fee to platform wallet", async () => {
    await setConfig("psp");
    const { escrowId } = await seedEscrow({ state: "escrow_held", amount: "10000.00", fee: "312.50", net: "9687.50" });

    const res = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: false,
      allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("settled");

    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("settled");
    expect(escrow.settledAt).toBeTruthy();
    expect(escrow.merchantWalletTxId).toBeTruthy();

    const wallet = await walletOf(TENANT);
    expect(parseFloat(wallet.availableBalance)).toBeCloseTo(9687.5, 2);
    expect(parseFloat(wallet.totalEarned)).toBeCloseTo(9687.5, 2);

    const txs = await walletTxs(wallet.id);
    const release = txs.find((t) => t.type === "escrow_release");
    const feeTx = txs.find((t) => t.type === "fee_deduction");
    expect(parseFloat(release!.amount)).toBeCloseTo(9687.5, 2);
    expect(parseFloat(feeTx!.amount)).toBeCloseTo(312.5, 2);

    // Platform fee wallet holds the fee — money conserved end to end.
    const [platform] = await db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, PLATFORM_FEE_WALLET_ID));
    expect(parseFloat(platform.availableBalance)).toBeCloseTo(312.5, 2);
    expect(9687.5 + 312.5).toBe(10000);
  });

  it("refuses a second settle (state guard) — no double wallet credit", async () => {
    await setConfig("psp");
    const { escrowId } = await seedEscrow({ state: "escrow_held", amount: "5000.00", fee: "156.25", net: "4843.75" });

    const first = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: false,
      allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    expect(first.transitioned).toBe(true);
    const second = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: false,
      allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    expect(second.transitioned).toBe(false);

    const wallet = await walletOf(TENANT);
    // 4843.75 from this test only (fresh tenant wallet per run is cumulative
    // within the file — assert the delta via wallet tx count instead).
    const txs = (await walletTxs(wallet.id)).filter((t) => t.type === "escrow_release");
    expect(txs.length).toBe(2); // one from previous test + one here — NOT three
  });

  it("does not settle from a disallowed state", async () => {
    await setConfig("psp");
    const { escrowId } = await seedEscrow({ state: "escrow_held", amount: "1000.00", fee: "31.25", net: "968.75" });
    const res = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: false,
      allowedFromStates: ["delivery_confirmed"],
    });
    expect(res.transitioned).toBe(false);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("escrow_held");
  });
});

// ─── Real settlement path: PSSP custody (bank release instruction) ────────────
describe("settleEscrowAtomic — PSSP custody (real code, PGlite)", () => {
  it("settles escrow_held → release_instructed with a bank ref and NO wallet credit", async () => {
    await setConfig("pssp");
    const { escrowId } = await seedEscrow({
      state: "escrow_held", amount: "2000.00", fee: "62.50", net: "1937.50", custodyMode: "pssp",
    });
    const before = (await db.select().from(schema.walletTransactions)).length;

    const res = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: true,
      allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("release_instructed");

    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("release_instructed");
    expect(escrow.bankRef).toMatch(/^ESCROW-REL-/);
    expect(escrow.autoConfirmed).toBe(true);

    const after = (await db.select().from(schema.walletTransactions)).length;
    expect(after).toBe(before); // PSSP: bank moves the money, not the wallet
  });
});

// ─── Real refund path ─────────────────────────────────────────────────────────
describe("refundEscrowAtomic (real code, PGlite)", () => {
  it("fully refunds an escrow_held escrow and records the wallet ledger entry", async () => {
    await setConfig("psp");
    const { escrowId } = await seedEscrow({ state: "escrow_held", amount: "3000.00", fee: "93.75", net: "2906.25" });

    const res = await refundEscrowAtomic(db as any, escrowId, { reason: "buyer cancelled" });
    expect(res.success).toBe(true);
    expect(res.fullRefund).toBe(true);
    expect(res.refundedAmount).toBeCloseTo(3000, 2);
    expect(res.remaining).toBe(0);

    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("refunded");
    expect(escrow.refundedAt).toBeTruthy();

    const wallet = await walletOf(TENANT);
    const txs = await walletTxs(wallet.id);
    const refundTx = txs.find((t) => t.type === "escrow_refund" && t.escrowTxId === escrowId);
    expect(refundTx).toBeTruthy();
    expect(parseFloat(refundTx!.amount)).toBeCloseTo(3000, 2);
  });

  it("supports partial refunds, accumulates metadata, and refuses over-refund", async () => {
    await setConfig("psp");
    const { escrowId } = await seedEscrow({ state: "escrow_held", amount: "1000.00", fee: "31.25", net: "968.75" });

    const part = await refundEscrowAtomic(db as any, escrowId, { reason: "partial", refundAmount: 100 });
    expect(part.success).toBe(true);
    expect(part.fullRefund).toBe(false);
    expect(part.remaining).toBeCloseTo(900, 2);

    let [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("escrow_held"); // partial refund keeps state
    expect((escrow.metadata as any).refundedAmount).toBe("100.00");

    const tooMuch = await refundEscrowAtomic(db as any, escrowId, { reason: "greedy", refundAmount: 901 });
    expect(tooMuch.success).toBe(false);
    expect(tooMuch.error).toMatch(/exceeds remaining/);

    const rest = await refundEscrowAtomic(db as any, escrowId, { reason: "remainder", refundAmount: 900 });
    expect(rest.success).toBe(true);
    expect(rest.fullRefund).toBe(true);
    [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("refunded");

    // Terminal: nothing more can be refunded.
    const again = await refundEscrowAtomic(db as any, escrowId, { reason: "again" });
    expect(again.success).toBe(false);
  });

  it("never refunds a settled escrow", async () => {
    await setConfig("psp");
    const { escrowId } = await seedEscrow({ state: "escrow_held", amount: "800.00", fee: "25.00", net: "775.00" });
    const settled = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: false,
      allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    expect(settled.transitioned).toBe(true);

    const res = await refundEscrowAtomic(db as any, escrowId, { reason: "too late" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Cannot refund from state: settled/);
  });

  it("returns 'Escrow not found' for unknown ids", async () => {
    await setConfig("psp");
    const res = await refundEscrowAtomic(db as any, crypto.randomUUID(), { reason: "ghost" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Escrow not found");
  });
});
