/**
 * W30 escrow-lifecycle unit tests (Coder B) — real code against PGlite:
 *
 *  - runSlaScan (verify-v1 #6): skips+alerts escrows whose order is NOT
 *    delivered; cancelled orders are REFUNDED, never released.
 *  - confirmEscrowDelivery (verify-v1 #14): the shared helper resets the
 *    buyer-protection deadline on every delivery_confirmed transition.
 *  - settleEscrowAtomic from dispute states (verify-v1 #7): dispute
 *    resolution releases via the hardened helper.
 *  - refund sweep flag (verify-v1 #8): escrows flagged refundSweepRequired
 *    are refunded by the scan, never settled.
 *
 * Only out-of-process collaborators are mocked (ledger bridge, notifications,
 * audit); DB reads/writes and money movement are the production code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import net from "net";
import crypto from "crypto";

process.env.NODE_ENV = "test";
process.env.TZ = "UTC";

const notifyOwner = vi.fn(async () => true);
vi.mock("./_core/notification", () => ({ notifyOwner: (...a: unknown[]) => notifyOwner(...a) }));
vi.mock("./routers/notifications", () => ({
  emitNotification: vi.fn(async () => ({})),
  NOTIFICATION_TEMPLATES: {},
}));
vi.mock("./services/ledgerBridge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/ledgerBridge")>();
  return { ...orig, ledgerBridgeRequest: vi.fn(async () => ({})), reverseCommittedTransfer: vi.fn(async () => ({})) };
});
vi.mock("./storage", () => ({ storagePut: vi.fn(), storageGet: vi.fn() }));

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../drizzle/schema";

type Db = ReturnType<typeof drizzle>;

// getDb indirection so server/routers/sla.ts (which resolves getDb at call
// time) sees the PGlite-backed drizzle instance.
let dbHolder: { db: Db | null } = { db: null };
vi.mock("./db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./db")>();
  return { ...orig, getDb: async () => dbHolder.db };
});

let pg: PGlite;
let pgServer: PGLiteSocketServer;
let client: ReturnType<typeof postgres>;
let db: Db;
let runSlaScan: typeof import("./routers/sla").runSlaScan;
let settleEscrowAtomic: typeof import("./routers/escrow").settleEscrowAtomic;
let refundEscrowAtomic: typeof import("./routers/escrow").refundEscrowAtomic;
let confirmEscrowDelivery: typeof import("./services/escrowLifecycle").confirmEscrowDelivery;

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
  dbHolder.db = db;

  const slaMod = await import("./routers/sla");
  runSlaScan = slaMod.runSlaScan;
  const escrowMod = await import("./routers/escrow");
  settleEscrowAtomic = escrowMod.settleEscrowAtomic;
  refundEscrowAtomic = escrowMod.refundEscrowAtomic;
  const lifecycle = await import("./services/escrowLifecycle");
  confirmEscrowDelivery = lifecycle.confirmEscrowDelivery;

  await db.delete(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1));
  await db.insert(schema.escrowConfig).values({
    id: 1, custodyMode: "psp", platformFeeRate: "0.03125",
    buyerConfirmWindowHours: 24, disputeWindowHours: 48,
    autoConfirmEnabled: true, floatYieldRate: "0.08", updatedAt: new Date(),
  });
}, 120_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  await pgServer?.stop().catch(() => {});
  await pg?.close().catch(() => {});
});

const TENANT = "w30-test-tenant";
let seq = 0;

async function seedOrderWithEscrow(opts: {
  orderStatus: string;
  escrowState: string;
  overdueDeadline?: boolean;
  metadata?: Record<string, unknown>;
}) {
  const n = ++seq;
  const customerId = crypto.randomUUID();
  await db.insert(schema.customers).values({
    id: customerId, tenantId: TENANT, whatsappPhone: `23481${String(n).padStart(8, "0")}`,
    createdAt: new Date(), updatedAt: new Date(),
  });
  const orderId = crypto.randomUUID();
  await db.insert(schema.orders).values({
    id: orderId, tenantId: TENANT, customerId,
    orderNumber: `W30-${n}`, status: opts.orderStatus as any,
    totalAmount: "10000.00", currency: "NGN",
    paymentStatus: opts.orderStatus === "cancelled" ? "completed" : "completed",
    createdAt: new Date(), updatedAt: new Date(),
  });
  const escrowId = crypto.randomUUID();
  await db.insert(schema.escrowTransactions).values({
    id: escrowId, orderId, tenantId: TENANT, customerId,
    amount: "10000.00", platformFee: "312.50", netMerchantAmount: "9687.50",
    currency: "NGN", custodyMode: "psp", state: opts.escrowState as any,
    buyerConfirmDeadline: opts.overdueDeadline ? new Date(Date.now() - 3600_000) : new Date(Date.now() + 24 * 3600_000),
    metadata: opts.metadata ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { escrowId, orderId, customerId };
}

describe("runSlaScan — W30 order-status guard (verify-v1 #6)", () => {
  it("REFUNDS an overdue escrow whose order was cancelled — never releases", async () => {
    const { escrowId, orderId } = await seedOrderWithEscrow({
      orderStatus: "cancelled", escrowState: "escrow_held", overdueDeadline: true,
    });
    const res = await runSlaScan();
    expect(res.refunded).toBeGreaterThanOrEqual(1);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("refunded");
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    // W30 hotfix (verify-v1 #9): no provider payment exists in this unit
    // fixture, so the honest order payment status is "refund_recorded"
    // (internal ledger refund only — never claimed as returned to a bank).
    expect(order.paymentStatus).toBe("refund_recorded");
    // Refund wallet ledger entry recorded (money moved out of escrow).
    const txs = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.escrowTxId, escrowId));
    expect(txs.some((t) => t.type === "escrow_refund")).toBe(true);
  });

  it("SKIPS + ALERTS an overdue escrow whose order is not delivered", async () => {
    notifyOwner.mockClear();
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "processing", escrowState: "escrow_held", overdueDeadline: true,
    });
    const res = await runSlaScan();
    expect(res.skippedUndelivered).toBeGreaterThanOrEqual(1);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("escrow_held"); // NOT settled
    expect(notifyOwner).toHaveBeenCalled();
    const alertArg = notifyOwner.mock.calls[0]?.[0] as { title?: string };
    expect(String(alertArg?.title ?? "")).toContain("BLOCKED");
  });

  it("SKIPS + ALERTS a courier_unverified escrow even when the order is delivered (verify-v1 #11 hotfix)", async () => {
    notifyOwner.mockClear();
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "delivered", escrowState: "delivery_confirmed", overdueDeadline: true,
      metadata: { buyerProtection: "courier_unverified" },
    });
    const res = await runSlaScan();
    expect(res.skippedCourierUnverified).toBeGreaterThanOrEqual(1);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("delivery_confirmed"); // NEVER auto-settled
    expect(notifyOwner).toHaveBeenCalled();
    const titles = notifyOwner.mock.calls.map((c) => String((c[0] as { title?: string })?.title ?? ""));
    expect(titles.some((t) => t.includes("unverified courier"))).toBe(true);
  });

  it("SETTLES an overdue escrow whose order IS delivered", async () => {
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "delivered", escrowState: "delivery_confirmed", overdueDeadline: true,
    });
    const res = await runSlaScan();
    expect(res.settled).toBeGreaterThanOrEqual(1);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("settled");
  });

  it("refund-sweep-flagged escrows are refunded, never settled (verify-v1 #8)", async () => {
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "delivered", escrowState: "escrow_held", overdueDeadline: true,
      metadata: { refundSweepRequired: true },
    });
    const res = await runSlaScan();
    expect(res.refunded).toBeGreaterThanOrEqual(1);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("refunded");
    expect((escrow.metadata as Record<string, unknown>).refundSweepRequired).toBe(false);
  });
});

describe("confirmEscrowDelivery — shared deadline reset (verify-v1 #14)", () => {
  it("resets the buyer-protection deadline from the delivery moment", async () => {
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "shipped", escrowState: "escrow_held", overdueDeadline: true,
    });
    const before = Date.now();
    const res = await confirmEscrowDelivery(db as any, { escrowTxId: escrowId });
    expect(res.transitioned).toEqual([escrowId]);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("delivery_confirmed");
    const dl = new Date(escrow.buyerConfirmDeadline!).getTime();
    // 24h window from NOW — not the stale payment-time deadline.
    expect(dl).toBeGreaterThan(before + 23 * 3600_000);
    expect(dl).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 5000);
  });

  it("matches by orderId and is a guarded no-op on replay", async () => {
    const { escrowId, orderId } = await seedOrderWithEscrow({
      orderStatus: "shipped", escrowState: "escrow_held",
    });
    const first = await confirmEscrowDelivery(db as any, { orderId });
    expect(first.transitioned).toEqual([escrowId]);
    const replay = await confirmEscrowDelivery(db as any, { orderId });
    expect(replay.transitioned).toEqual([]);
  });
});

describe("dispute resolution money movement (verify-v1 #7)", () => {
  it("settleEscrowAtomic releases directly from dispute_raised via the atomic helper", async () => {
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "delivered", escrowState: "dispute_raised",
    });
    const res = await settleEscrowAtomic(db as any, escrowId, {
      autoConfirmed: false,
      allowedFromStates: ["dispute_raised", "dispute_resolved"],
      descriptionPrefix: "Dispute resolved in merchant's favour",
    });
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("settled");
  });

  it("refundEscrowAtomic refunds a disputed escrow fully", async () => {
    const { escrowId } = await seedOrderWithEscrow({
      orderStatus: "delivered", escrowState: "dispute_raised",
    });
    const res = await refundEscrowAtomic(db as any, escrowId, { reason: "dispute full_refund_to_buyer" });
    expect(res.success).toBe(true);
    expect(res.fullRefund).toBe(true);
    const [escrow] = await db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrowId));
    expect(escrow.state).toBe("refunded");
  });
});
