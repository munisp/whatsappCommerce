import { z } from "zod";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  escrowTransactions, escrowConfig, escrowDisputes,
  merchantWallets, walletTransactions,
  orders, logisticsShipments,
  type EscrowTransaction, type EscrowConfig,
} from "../../drizzle/schema";
import { escrowTimelineAttachments } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { emitNotification, NOTIFICATION_TEMPLATES } from "./notifications";

// ─── Helper: get or seed escrow config ───────────────────────────────────────
async function getEscrowConfig(db: Awaited<ReturnType<typeof getDb>>) {
  if (!db) throw new Error("DB unavailable");
  const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
  if (!cfg) {
    await db.insert(escrowConfig).values({
      id: 1,
      custodyMode: "pssp",
      platformFeeRate: "0.03125",
      buyerConfirmWindowHours: 24,
      disputeWindowHours: 48,
      autoConfirmEnabled: true,
      floatYieldRate: "0.08",
      updatedAt: new Date(),
    }).onConflictDoNothing();
    const [seeded] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
    return seeded!;
  }
  return cfg;
}

// ─── Helper: get or create merchant wallet ────────────────────────────────────
async function getOrCreateWallet(db: Awaited<ReturnType<typeof getDb>>, tenantId: string, custodyMode: "pssp" | "psp" = "pssp") {
  if (!db) throw new Error("DB unavailable");
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({
    id, tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.id, id));
  return created!;
}

// ─── Helper: record wallet transaction (double-entry) ─────────────────────────
async function recordWalletTx(
  db: Awaited<ReturnType<typeof getDb>>,
  walletId: string,
  tenantId: string,
  type: "escrow_credit" | "escrow_release" | "escrow_refund" | "float_income" | "withdrawal" | "fee_deduction",
  amount: number,
  opts: { orderId?: string; escrowTxId?: string; description?: string; reference?: string },
) {
  if (!db) throw new Error("DB unavailable");
  const [wallet] = await db.select().from(merchantWallets).where(eq(merchantWallets.id, walletId));
  if (!wallet) throw new Error("Wallet not found");
  const before = parseFloat(wallet.availableBalance);
  const after = type === "escrow_release" || type === "float_income"
    ? before + amount
    : type === "fee_deduction" || type === "withdrawal"
    ? before - amount
    : before; // escrow_credit goes to escrowBalance, not availableBalance

  const txId = crypto.randomUUID();
  await db.insert(walletTransactions).values({
    id: txId, walletId, tenantId, type,
    amount: amount.toFixed(2),
    balanceBefore: before.toFixed(2),
    balanceAfter: after.toFixed(2),
    currency: wallet.currency,
    orderId: opts.orderId,
    escrowTxId: opts.escrowTxId,
    description: opts.description,
    reference: opts.reference,
    createdAt: new Date(),
  });

  // Update wallet balances
  if (type === "escrow_credit") {
    await db.update(merchantWallets).set({
      escrowBalance: sql`${merchantWallets.escrowBalance} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "escrow_release") {
    await db.update(merchantWallets).set({
      escrowBalance: sql`GREATEST(${merchantWallets.escrowBalance} - ${amount.toFixed(2)}, 0)`,
      availableBalance: sql`${merchantWallets.availableBalance} + ${amount.toFixed(2)}`,
      totalEarned: sql`${merchantWallets.totalEarned} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "escrow_refund") {
    await db.update(merchantWallets).set({
      escrowBalance: sql`GREATEST(${merchantWallets.escrowBalance} - ${amount.toFixed(2)}, 0)`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "float_income") {
    await db.update(merchantWallets).set({
      availableBalance: sql`${merchantWallets.availableBalance} + ${amount.toFixed(2)}`,
      totalEarned: sql`${merchantWallets.totalEarned} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "fee_deduction" || type === "withdrawal") {
    await db.update(merchantWallets).set({
      availableBalance: sql`GREATEST(${merchantWallets.availableBalance} - ${amount.toFixed(2)}, 0)`,
      totalWithdrawn: type === "withdrawal"
        ? sql`${merchantWallets.totalWithdrawn} + ${amount.toFixed(2)}`
        : merchantWallets.totalWithdrawn,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  }
  return txId;
}

// ─── Escrow Router ────────────────────────────────────────────────────────────
export const escrowRouter = router({

  // Get platform escrow config
  getConfig: protectedProcedure.query(async () => {
    const db = await getDb();
    return getEscrowConfig(db);
  }),

  // Update escrow config (admin only)
  setConfig: protectedProcedure
    .input(z.object({
      custodyMode: z.enum(["pssp", "psp"]).optional(),
      bankPartnerName: z.string().optional(),
      bankPartnerCode: z.string().optional(),
      bankApiBaseUrl: z.string().optional(),
      bankEscrowAccountNumber: z.string().optional(),
      shipbubbleApiKey: z.string().optional(),
      shipbubbleWebhookSecret: z.string().optional(),
      platformFeeRate: z.string().optional(),
      buyerConfirmWindowHours: z.number().optional(),
      disputeWindowHours: z.number().optional(),
      autoConfirmEnabled: z.boolean().optional(),
      floatYieldRate: z.string().optional(),
      minScanConfidence: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(escrowConfig).set({
        ...input,
        updatedAt: new Date(),
      }).where(eq(escrowConfig.id, 1));
      return getEscrowConfig(db);
    }),

  // Create escrow hold when payment is confirmed
  createHold: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      tenantId: z.string(),
      customerId: z.string().optional(),
      amount: z.number(),
      currency: z.string().default("NGN"),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);

      // Idempotency check
      if (input.idempotencyKey) {
        const [existing] = await db.select().from(escrowTransactions)
          .where(eq(escrowTransactions.idempotencyKey, input.idempotencyKey));
        if (existing) return existing;
      }

      const feeRate = parseFloat(cfg.platformFeeRate);
      const fee = input.amount * feeRate;
      const netMerchant = input.amount - fee;
      const buyerDeadline = new Date(Date.now() + cfg.buyerConfirmWindowHours * 3600 * 1000);

      const id = crypto.randomUUID();
      await db.insert(escrowTransactions).values({
        id,
        orderId: input.orderId,
        tenantId: input.tenantId,
        customerId: input.customerId,
        amount: input.amount.toFixed(2),
        platformFee: fee.toFixed(2),
        netMerchantAmount: netMerchant.toFixed(2),
        currency: input.currency,
        custodyMode: cfg.custodyMode,
        state: "escrow_held",
        buyerConfirmDeadline: buyerDeadline,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // PSP mode: credit merchant escrow wallet
      if (cfg.custodyMode === "psp") {
        const wallet = await getOrCreateWallet(db, input.tenantId, "psp");
        const txId = await recordWalletTx(db, wallet.id, input.tenantId, "escrow_credit", input.amount, {
          orderId: input.orderId, escrowTxId: id,
          description: `Escrow hold for order ${input.orderId}`,
        });
        await db.update(escrowTransactions).set({ buyerWalletTxId: txId, updatedAt: new Date() })
          .where(eq(escrowTransactions.id, id));
      }

      // Update order status to processing
      await db.update(orders).set({ status: "processing", updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));

      const [created] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, id));
      // Fire-and-forget: notify merchant of escrow hold
      emitNotification({
        id: crypto.randomUUID(), tenantId: input.tenantId, type: "escrow_held",
        title: "Payment Held in Escrow",
        body: `₦${input.amount.toLocaleString()} for order ${input.orderId} is now held in escrow pending delivery.`,
        metadata: { orderId: input.orderId, amount: input.amount },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return created!;
    }),

  // Confirm delivery and trigger buyer confirmation window
  confirmDelivery: protectedProcedure
    .input(z.object({
      escrowId: z.string(),
      shipmentId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) throw new Error("Escrow transaction not found");
      if (!["escrow_held"].includes(escrow.state)) throw new Error(`Cannot confirm delivery in state: ${escrow.state}`);

      const deadline = new Date(Date.now() + cfg.buyerConfirmWindowHours * 3600 * 1000);
      await db.update(escrowTransactions).set({
        state: "delivery_confirmed",
        deliveryConfirmedAt: new Date(),
        shipmentId: input.shipmentId,
        buyerConfirmDeadline: deadline,
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, input.escrowId));

      // Update order status to delivered
      await db.update(orders).set({ status: "delivered", updatedAt: new Date() })
        .where(eq(orders.id, escrow.orderId));

      const [updated] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, input.escrowId));
      // Fire-and-forget: notify merchant of delivery confirmation
      emitNotification({
        id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "delivery_confirmed",
        title: "Delivery Confirmed",
        body: `Order ${escrow.orderId} has been marked as delivered. Escrow release is in progress.`,
        metadata: { orderId: escrow.orderId, escrowId: input.escrowId },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return updated!;
    }),

  // Buyer confirms receipt → release to merchant
  buyerConfirm: protectedProcedure
    .input(z.object({ escrowId: z.string(), autoConfirmed: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) throw new Error("Escrow not found");
      if (!["delivery_confirmed", "escrow_held"].includes(escrow.state)) {
        throw new Error(`Cannot confirm in state: ${escrow.state}`);
      }

      const netAmount = parseFloat(escrow.netMerchantAmount);
      const fee = parseFloat(escrow.platformFee);

      if (cfg.custodyMode === "psp") {
        // PSP: internal wallet release
        const wallet = await getOrCreateWallet(db, escrow.tenantId, "psp");
        const releaseTxId = await recordWalletTx(db, wallet.id, escrow.tenantId, "escrow_release", netAmount, {
          orderId: escrow.orderId, escrowTxId: escrow.id,
          description: `Settlement for order ${escrow.orderId}`,
        });
        await recordWalletTx(db, wallet.id, escrow.tenantId, "fee_deduction", fee, {
          orderId: escrow.orderId, escrowTxId: escrow.id,
          description: `Platform fee (${(parseFloat(cfg.platformFeeRate) * 100).toFixed(2)}%) for order ${escrow.orderId}`,
        });
        await db.update(escrowTransactions).set({
          state: "settled",
          buyerConfirmedAt: input.autoConfirmed ? null : new Date(),
          autoConfirmed: input.autoConfirmed,
          settledAt: new Date(),
          merchantWalletTxId: releaseTxId,
          updatedAt: new Date(),
        }).where(eq(escrowTransactions.id, input.escrowId));
      } else {
        // PSSP: issue release instruction to bank partner
        const bankRef = `ESCROW-REL-${input.escrowId.slice(0, 8).toUpperCase()}-${Date.now()}`;
        await db.update(escrowTransactions).set({
          state: "release_instructed",
          buyerConfirmedAt: input.autoConfirmed ? null : new Date(),
          autoConfirmed: input.autoConfirmed,
          releaseInstructedAt: new Date(),
          bankRef,
          updatedAt: new Date(),
        }).where(eq(escrowTransactions.id, input.escrowId));
      }

      await db.update(orders).set({ status: "delivered", paymentStatus: "completed", updatedAt: new Date() })
        .where(eq(orders.id, escrow.orderId));

      const [updated] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, input.escrowId));
      // Fire-and-forget: notify merchant of settlement
      emitNotification({
        id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "escrow_settled",
        title: cfg.custodyMode === "psp" ? "Funds Released to Your Wallet" : "Release Instruction Sent",
        body: cfg.custodyMode === "psp"
          ? `₦${parseFloat(escrow.netMerchantAmount).toLocaleString()} from order ${escrow.orderId} released to your wallet.`
          : `Release instruction sent to bank for ₦${parseFloat(escrow.netMerchantAmount).toLocaleString()} from order ${escrow.orderId}.`,
        metadata: { orderId: escrow.orderId, escrowId: input.escrowId, netAmount: escrow.netMerchantAmount },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return updated!;
    }),

  // Bank confirms settlement (PSSP mode callback)
  bankSettlementConfirmed: protectedProcedure
    .input(z.object({ escrowId: z.string(), bankRef: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(escrowTransactions).set({
        state: "settled",
        bankSettlementConfirmedAt: new Date(),
        settledAt: new Date(),
        bankRef: input.bankRef,
        updatedAt: new Date(),
      }).where(and(
        eq(escrowTransactions.id, input.escrowId),
        eq(escrowTransactions.state, "release_instructed"),
      ));
      const [updated] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, input.escrowId));
      return updated!;
    }),

  // Initiate refund (dispute resolved in buyer's favour or manual refund)
  initiateRefund: protectedProcedure
    .input(z.object({
      escrowId: z.string(),
      reason: z.string(),
      refundAmount: z.number().optional(), // partial refund support
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) throw new Error("Escrow not found");
      if (["settled", "refunded"].includes(escrow.state)) throw new Error("Cannot refund a settled or already-refunded escrow");

      const refundAmt = input.refundAmount ?? parseFloat(escrow.amount);

      if (cfg.custodyMode === "psp") {
        const wallet = await getOrCreateWallet(db, escrow.tenantId, "psp");
        await recordWalletTx(db, wallet.id, escrow.tenantId, "escrow_refund", refundAmt, {
          orderId: escrow.orderId, escrowTxId: escrow.id,
          description: `Refund: ${input.reason}`,
        });
      }

      await db.update(escrowTransactions).set({
        state: "refunded",
        refundedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, input.escrowId));

      await db.update(orders).set({ status: "refunded", paymentStatus: "refunded", updatedAt: new Date() })
        .where(eq(orders.id, escrow.orderId));

      const [updated] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, input.escrowId));
      // Fire-and-forget: notify merchant of refund
      emitNotification({
        id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "escrow_refunded",
        title: "Escrow Refunded to Buyer",
        body: `Order ${escrow.orderId} refunded. ₦${refundAmt.toLocaleString()} returned to buyer. Reason: ${input.reason}.`,
        metadata: { orderId: escrow.orderId, escrowId: input.escrowId, amount: refundAmt },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return updated!;
    }),

  // Get escrow by order
  getByOrder: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.orderId, input.orderId))
        .orderBy(desc(escrowTransactions.createdAt));
      return escrow ?? null;
    }),

  // List all escrow transactions (admin)
  listAll: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      state: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };
      const conditions = [];
      if (input.tenantId) conditions.push(eq(escrowTransactions.tenantId, input.tenantId));
      if (input.state) conditions.push(eq(escrowTransactions.state, input.state as any));
      const items = await db.select().from(escrowTransactions)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(escrowTransactions.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
        .from(escrowTransactions)
        .where(conditions.length ? and(...conditions) : undefined);
      return { items, total: count };
    }),

  // Platform-level stats
  getStats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return null;
    const cfg = await getEscrowConfig(db);
    const rows = await db.select({
      state: escrowTransactions.state,
      count: sql<number>`count(*)::int`,
      totalAmount: sql<string>`coalesce(sum(amount::numeric), 0)::text`,
      totalFees: sql<string>`coalesce(sum(platform_fee::numeric), 0)::text`,
    }).from(escrowTransactions).groupBy(escrowTransactions.state);

    type RowType = { state: string; count: number; totalAmount: string; totalFees: string };
    const byState = Object.fromEntries((rows as RowType[]).map((r) => [r.state, { count: r.count, amount: r.totalAmount, fees: r.totalFees }]));
    const totalHeld = rows
      .filter((r) => ["escrow_held", "delivery_confirmed", "release_instructed"].includes(r.state))
      .reduce((s: number, r: typeof rows[0]) => s + parseFloat(r.totalAmount), 0);
    const totalSettled = rows
      .filter((r: typeof rows[0]) => (r.state as string) === "settled")
      .reduce((s: number, r: typeof rows[0]) => s + parseFloat(r.totalAmount), 0);
    const totalFees = rows.reduce((s: number, r: typeof rows[0]) => s + parseFloat(r.totalFees), 0);
    const openDisputes = await db.select({ count: sql<number>`count(*)::int` })
      .from(escrowDisputes).where(inArray(escrowDisputes.status, ["open", "under_review"]));

      return {
        custodyMode: cfg.custodyMode,
        byState,
        totalHeld,
        totalSettled,
        totalFees,
        openDisputes: openDisputes[0]?.count ?? 0,
        platformFeeRate: cfg.platformFeeRate,
      };
    }),

  /** Get ordered timeline of all events for a single escrow transaction */
  getTimeline: protectedProcedure
    .input(z.object({ escrowId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) return [];

      const [shipment] = await db.select().from(logisticsShipments)
        .where(eq(logisticsShipments.escrowTxId, input.escrowId));

      const disputes = await db.select().from(escrowDisputes)
        .where(eq(escrowDisputes.escrowTxId, input.escrowId));

      type TimelineEvent = {
        id: string;
        timestamp: Date;
        type: "escrow_state" | "logistics" | "dispute";
        state?: string;
        title: string;
        description: string;
        icon: string;
        variant: "default" | "success" | "warning" | "error" | "info";
      };

      const events: TimelineEvent[] = [];

      // Escrow state events
      events.push({ id: `${input.escrowId}-created`, timestamp: escrow.createdAt, type: "escrow_state", state: "payment_received", title: "Payment Received", description: `₦${Number(escrow.amount).toLocaleString()} received from buyer. Escrow process initiated.`, icon: "circle-dollar-sign", variant: "info" });

      if (escrow.bankHoldConfirmedAt || !["payment_received"].includes(escrow.state)) {
        events.push({ id: `${input.escrowId}-held`, timestamp: escrow.bankHoldConfirmedAt ?? escrow.updatedAt, type: "escrow_state", state: "escrow_held", title: "Funds Held in Escrow", description: escrow.custodyMode === "psp" ? `₦${Number(escrow.amount).toLocaleString()} held in platform wallet. Awaiting delivery.` : `₦${Number(escrow.amount).toLocaleString()} held at bank partner (${escrow.bankRef ?? "pending ref"}). Awaiting delivery.`, icon: "lock", variant: "default" });
      }

      if (escrow.deliveryConfirmedAt) {
        events.push({ id: `${input.escrowId}-delivery`, timestamp: escrow.deliveryConfirmedAt, type: "escrow_state", state: "delivery_confirmed", title: "Delivery Confirmed", description: escrow.autoConfirmed ? "Delivery auto-confirmed after buyer confirmation window expired." : "Delivery confirmed by buyer via WhatsApp.", icon: "package-check", variant: "success" });
      }

      if (escrow.releaseInstructedAt) {
        events.push({ id: `${input.escrowId}-release`, timestamp: escrow.releaseInstructedAt, type: "escrow_state", state: "release_instructed", title: "Release Instruction Sent", description: `Platform instructed bank partner to release ₦${Number(escrow.netMerchantAmount).toLocaleString()} to merchant wallet.`, icon: "send", variant: "info" });
      }

      if (escrow.settledAt) {
        events.push({ id: `${input.escrowId}-settled`, timestamp: escrow.settledAt, type: "escrow_state", state: "settled", title: "Funds Released to Merchant", description: `₦${Number(escrow.netMerchantAmount).toLocaleString()} settled to merchant wallet. Platform fee: ₦${Number(escrow.platformFee).toLocaleString()}.`, icon: "check-circle", variant: "success" });
      }

      if (escrow.refundedAt) {
        events.push({ id: `${input.escrowId}-refunded`, timestamp: escrow.refundedAt, type: "escrow_state", state: "refunded", title: "Escrow Refunded", description: `₦${Number(escrow.amount).toLocaleString()} refunded to buyer.`, icon: "rotate-ccw", variant: "warning" });
      }

      // Logistics events
      if (shipment) {
        events.push({ id: `${input.escrowId}-shipment-created`, timestamp: shipment.createdAt, type: "logistics", title: "Shipment Created", description: `Tracking ID: ${shipment.trackingId ?? "pending"}. Provider: ${shipment.provider}.`, icon: "truck", variant: "info" });
        if (shipment.pickedUpAt) events.push({ id: `${input.escrowId}-picked-up`, timestamp: shipment.pickedUpAt, type: "logistics", title: "Package Picked Up", description: `${shipment.provider} collected the package from merchant.`, icon: "package", variant: "default" });
        if (shipment.inTransitAt) events.push({ id: `${input.escrowId}-in-transit`, timestamp: shipment.inTransitAt, type: "logistics", title: "In Transit", description: `Package is in transit to buyer.`, icon: "truck", variant: "info" });
        if (shipment.outForDeliveryAt) events.push({ id: `${input.escrowId}-out-for-delivery`, timestamp: shipment.outForDeliveryAt, type: "logistics", title: "Out for Delivery", description: `Package is out for delivery.`, icon: "navigation", variant: "info" });
        if (shipment.deliveredAt) events.push({ id: `${input.escrowId}-delivered`, timestamp: shipment.deliveredAt, type: "logistics", title: "Package Delivered", description: `Package delivered to buyer. Confirmation window started.`, icon: "package-check", variant: "success" });
      }

      // Dispute events
      for (const dispute of disputes) {
        events.push({ id: `${input.escrowId}-dispute-${dispute.id}`, timestamp: dispute.createdAt, type: "dispute", title: "Dispute Raised", description: `${dispute.raisedBy === "buyer" ? "Buyer" : "Merchant"} raised a dispute. Reason: ${dispute.reason}.`, icon: "alert-triangle", variant: "error" });
        if (dispute.resolvedAt) {
          events.push({ id: `${input.escrowId}-dispute-resolved-${dispute.id}`, timestamp: dispute.resolvedAt, type: "dispute", title: "Dispute Resolved", description: `Resolution: ${dispute.resolution ?? "see details"}. ${dispute.resolverNotes ? `Notes: ${dispute.resolverNotes}` : ""}`, icon: "check-circle-2", variant: "success" });
        }
      }

      events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      return events;
    }),
});

// ─── Escrow Dispute Router ────────────────────────────────────────────────────
export const escrowDisputeRouter = router({

  raise: protectedProcedure
    .input(z.object({
      escrowTxId: z.string(),
      orderId: z.string(),
      tenantId: z.string(),
      raisedBy: z.enum(["buyer", "merchant"]).default("buyer"),
      reason: z.enum(["not_received", "wrong_item", "damaged", "partial_delivery", "other"]),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);

      // Freeze the escrow
      await db.update(escrowTransactions).set({
        state: "dispute_raised",
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, input.escrowTxId));

      const id = crypto.randomUUID();
      const merchantDeadline = new Date(Date.now() + cfg.disputeWindowHours * 3600 * 1000);
      await db.insert(escrowDisputes).values({
        id,
        escrowTxId: input.escrowTxId,
        orderId: input.orderId,
        tenantId: input.tenantId,
        raisedBy: input.raisedBy,
        reason: input.reason,
        description: input.description,
        status: "open",
        merchantResponseDeadline: merchantDeadline,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [created] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, id));
      // Fire-and-forget: notify merchant of dispute
      emitNotification({
        id: crypto.randomUUID(), tenantId: input.tenantId, type: "dispute_opened",
        title: "Dispute Opened on Your Order",
        body: `A ${input.raisedBy} has raised a dispute on order ${input.orderId}. Reason: ${input.reason.replace(/_/g, " ")}. Please respond within ${cfg.disputeWindowHours}h.`,
        metadata: { orderId: input.orderId, escrowTxId: input.escrowTxId, disputeId: id },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return created!;
    }),

  list: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [];
      if (input.tenantId) conditions.push(eq(escrowDisputes.tenantId, input.tenantId));
      if (input.status) conditions.push(eq(escrowDisputes.status, input.status as any));
      return db.select().from(escrowDisputes)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(escrowDisputes.createdAt))
        .limit(input.limit);
    }),

  getByOrder: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(escrowDisputes)
        .where(eq(escrowDisputes.orderId, input.orderId))
        .orderBy(desc(escrowDisputes.createdAt));
    }),

  review: protectedProcedure
    .input(z.object({
      disputeId: z.string(),
      resolution: z.enum(["full_release_to_merchant", "full_refund_to_buyer", "partial_refund", "no_action"]),
      refundAmount: z.number().optional(),
      resolverNotes: z.string().optional(),
      resolvedBy: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [dispute] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, input.disputeId));
      if (!dispute) throw new Error("Dispute not found");

      await db.update(escrowDisputes).set({
        status: "resolved_" + (input.resolution.includes("merchant") ? "merchant" : "buyer") as any,
        resolution: input.resolution,
        refundAmount: input.refundAmount?.toFixed(2),
        resolvedBy: input.resolvedBy,
        resolverNotes: input.resolverNotes,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(escrowDisputes.id, input.disputeId));

      // Update escrow state
      await db.update(escrowTransactions).set({
        state: "dispute_resolved",
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, dispute.escrowTxId));

      const [updated] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, input.disputeId));
      // Fire-and-forget: notify merchant of dispute resolution
      emitNotification({
        id: crypto.randomUUID(), tenantId: dispute.tenantId, type: "dispute_resolved",
        title: "Dispute Resolved",
        body: `Dispute on order ${dispute.orderId} has been resolved. Outcome: ${input.resolution.replace(/_/g, " ")}.${input.resolverNotes ? ` Notes: ${input.resolverNotes}` : ""}`,
        metadata: { orderId: dispute.orderId, disputeId: input.disputeId, resolution: input.resolution },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return updated!;
    }),
});

// ─── Wallet Router ────────────────────────────────────────────────────────────
export const walletRouter = router({

  getBalance: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [wallet] = await db.select().from(merchantWallets)
        .where(eq(merchantWallets.tenantId, input.tenantId));
      return wallet ?? null;
    }),

  listTransactions: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      type: z.string().optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const [wallet] = await db.select().from(merchantWallets)
        .where(eq(merchantWallets.tenantId, input.tenantId));
      if (!wallet) return [];
      const conditions = [eq(walletTransactions.walletId, wallet.id)];
      if (input.type) conditions.push(eq(walletTransactions.type, input.type as any));
      return db.select().from(walletTransactions)
        .where(and(...conditions))
        .orderBy(desc(walletTransactions.createdAt))
        .limit(input.limit);
    }),

  requestWithdrawal: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      amount: z.number().positive(),
      bankAccountName: z.string().optional(),
      bankAccountNumber: z.string().optional(),
      bankCode: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);
      if (cfg.custodyMode !== "psp") throw new Error("Withdrawals are only available under PSP licence mode");
      const wallet = await getOrCreateWallet(db, input.tenantId, "psp");
      if (parseFloat(wallet.availableBalance) < input.amount) {
        throw new Error("Insufficient available balance");
      }
      if (input.bankAccountNumber) {
        await db.update(merchantWallets).set({
          bankAccountName: input.bankAccountName,
          bankAccountNumber: input.bankAccountNumber,
          bankCode: input.bankCode,
          updatedAt: new Date(),
        }).where(eq(merchantWallets.id, wallet.id));
      }
      const ref = `WD-${Date.now()}-${input.tenantId.slice(0, 6).toUpperCase()}`;
      await recordWalletTx(db, wallet.id, input.tenantId, "withdrawal", input.amount, {
        description: `Withdrawal to ${input.bankAccountNumber ?? "bank account"}`,
        reference: ref,
      });
      return { success: true, reference: ref, amount: input.amount };
    }),

  getStats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return null;
    const [stats] = await db.select({
      totalWallets: sql<number>`count(*)::int`,
      totalAvailable: sql<string>`coalesce(sum(available_balance::numeric), 0)::text`,
      totalEscrow: sql<string>`coalesce(sum(escrow_balance::numeric), 0)::text`,
      totalEarned: sql<string>`coalesce(sum(total_earned::numeric), 0)::text`,
    }).from(merchantWallets);
    return stats;
  }),

  /** Export full wallet ledger as CSV string */
  exportLedgerCsv: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [wallet] = await db.select().from(merchantWallets)
        .where(eq(merchantWallets.tenantId, input.tenantId));
      if (!wallet) return { csv: "", filename: "ledger.csv", rowCount: 0 };

      const conditions: any[] = [eq(walletTransactions.walletId, wallet.id)];
      if (input.startDate) {
        conditions.push(sql`${walletTransactions.createdAt} >= ${new Date(input.startDate)}`);
      }
      if (input.endDate) {
        const end = new Date(input.endDate);
        end.setHours(23, 59, 59, 999);
        conditions.push(sql`${walletTransactions.createdAt} <= ${end}`);
      }
      const txs = await db.select().from(walletTransactions)
        .where(and(...conditions))
        .orderBy(desc(walletTransactions.createdAt));
      const header = ["Date", "Type", "Amount (NGN)", "Balance After (NGN)", "Reference", "Order ID", "Description"].join(",");
      const rows = txs.map((t) => [
        new Date(t.createdAt).toISOString(),
        t.type,
        t.amount,
        t.balanceAfter ?? "",
        t.reference ?? "",
        t.orderId ?? "",
        `"${(t.description ?? "").replace(/"/g, '""')}"`,
      ].join(","));

      const csv = [header, ...rows].join("\n");
      const dateTag = input.startDate && input.endDate
        ? `${input.startDate}_to_${input.endDate}`
        : new Date().toISOString().slice(0, 10);
      const filename = `wallet_ledger_${input.tenantId.slice(0, 8)}_${dateTag}.csv`;
      return { csv, filename, rowCount: txs.length };
    }),
});

// ─── Timeline Attachments Router ─────────────────────────────────────────────
export const timelineAttachmentRouter = router({

  add: protectedProcedure
    .input(z.object({
      escrowId: z.string(),
      eventId: z.string(),
      attachmentType: z.enum(["document", "note"]).default("note"),
      fileBase64: z.string().optional(),
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      note: z.string().optional(),
      uploadedBy: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      let fileUrl: string | undefined;
      let fileKey: string | undefined;
      if (input.attachmentType === "document" && input.fileBase64 && input.filename) {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const key = `escrow-attachments/${input.escrowId}/${input.eventId}/${Date.now()}-${input.filename}`;
        const result = await storagePut(key, buffer, input.mimeType ?? "application/octet-stream");
        fileUrl = result.url;
        fileKey = result.key;
      }
      const id = crypto.randomUUID();
      await db.insert(escrowTimelineAttachments).values({
        id, escrowId: input.escrowId, eventId: input.eventId,
        attachmentType: input.attachmentType,
        fileUrl, fileKey, filename: input.filename, mimeType: input.mimeType,
        note: input.note, uploadedBy: input.uploadedBy, createdAt: new Date(),
      });
      const [created] = await db.select().from(escrowTimelineAttachments)
        .where(eq(escrowTimelineAttachments.id, id));
      return created!;
    }),

  list: protectedProcedure
    .input(z.object({
      escrowId: z.string(),
      eventId: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions: any[] = [eq(escrowTimelineAttachments.escrowId, input.escrowId)];
      if (input.eventId) conditions.push(eq(escrowTimelineAttachments.eventId, input.eventId));
      return db.select().from(escrowTimelineAttachments)
        .where(and(...conditions))
        .orderBy(escrowTimelineAttachments.createdAt);
    }),
});
