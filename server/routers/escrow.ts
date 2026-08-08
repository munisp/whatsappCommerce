import { z } from "zod";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, adminProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { ENV } from "../_core/env";
import {
  escrowTransactions, escrowConfig, escrowDisputes,
  merchantWallets, walletTransactions,
  orders, customers, logisticsShipments, paymentIntents, paymentTransactions,
  type EscrowTransaction, type EscrowConfig,
} from "../../drizzle/schema";
import { escrowTimelineAttachments } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { emitNotification, NOTIFICATION_TEMPLATES } from "./notifications";
import { notifyOwner } from "../_core/notification";

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

// ─── DB / transaction handle types ───────────────────────────────────────────
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
// Both the pool-level drizzle instance and a transaction handle expose these.
type DbOrTx = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

// ─── Authorization helpers ───────────────────────────────────────────────────
type SessionUser = { id: number; role: string; email: string | null; phone: string | null; tenantId: string | null };

/** Verify the caller is the buyer of the escrow's order (or an admin). */
async function assertBuyerOrAdmin(db: DbOrTx, user: SessionUser, escrow: EscrowTransaction) {
  if (user.role === "admin") return;
  const [order] = await db.select().from(orders).where(eq(orders.id, escrow.orderId));
  const [customer] = order
    ? await db.select().from(customers).where(eq(customers.id, order.customerId))
    : [undefined];
  const userEmail = user.email?.trim().toLowerCase();
  const custEmail = customer?.email?.trim().toLowerCase();
  const emailMatch = !!userEmail && !!custEmail && userEmail === custEmail;
  const digits = (p?: string | null) => (p ?? "").replace(/\D/g, "");
  const phoneMatch = !!digits(user.phone) && digits(user.phone) === digits(customer?.whatsappPhone);
  if (!emailMatch && !phoneMatch) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the buyer of this order (or an admin) can confirm receipt" });
  }
}

// ─── Helper: get or create merchant wallet ────────────────────────────────────
async function getOrCreateWallet(db: DbOrTx, tenantId: string, custodyMode: "pssp" | "psp" = "pssp") {
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({
    id, tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  return created!;
}

// ─── Platform fee wallet (deterministic) ─────────────────────────────────────
// Platform fees collected at settlement are credited here so fee revenue is
// tracked as real money instead of vanishing from the ledger.
export const PLATFORM_FEE_WALLET_ID = "platform-fee-wallet";
const PLATFORM_FEE_TENANT_ID = "platform-fees";

async function getOrCreatePlatformFeeWallet(db: DbOrTx) {
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.id, PLATFORM_FEE_WALLET_ID));
  if (existing) return existing;
  await db.insert(merchantWallets).values({
    id: PLATFORM_FEE_WALLET_ID,
    tenantId: PLATFORM_FEE_TENANT_ID,
    currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.id, PLATFORM_FEE_WALLET_ID));
  return created!;
}

// ─── Helper: record wallet transaction (double-entry, transactional) ──────────
type WalletTxType = "escrow_credit" | "escrow_release" | "escrow_refund" | "float_income" | "withdrawal" | "fee_deduction";

/** Lock a wallet row inside an open transaction and return its balances. */
async function lockWalletRow(tx: DbOrTx, walletId: string): Promise<{ availableBalance: number; currency: string }> {
  const res = await tx.execute(sql`SELECT available_balance, currency FROM merchant_wallets WHERE id = ${walletId} FOR UPDATE`);
  const row = (res as unknown as Record<string, unknown>[])[0];
  if (!row) throw new Error("Wallet not found");
  return { availableBalance: parseFloat(String(row.available_balance)), currency: String(row.currency ?? "NGN") };
}

/**
 * Record a wallet ledger entry + balance update. MUST be called inside an open
 * DB transaction — the wallet row is locked with SELECT ... FOR UPDATE so
 * concurrent writers serialize and balances can never go wrong under load.
 */
async function recordWalletTxInTx(
  tx: DbOrTx,
  walletId: string,
  tenantId: string,
  type: WalletTxType,
  amount: number,
  opts: { orderId?: string; escrowTxId?: string; description?: string; reference?: string; metadata?: Record<string, unknown> },
) {
  const wallet = await lockWalletRow(tx, walletId);
  const before = wallet.availableBalance;
  // escrow_credit moves funds INTO escrowBalance; escrow_refund / fee_deduction
  // move funds OUT of escrowBalance (back to buyer / to the platform). Only
  // escrow_release, float_income and withdrawal touch availableBalance.
  const after = type === "escrow_release" || type === "float_income"
    ? before + amount
    : type === "withdrawal"
    ? before - amount
    : before;

  const txId = crypto.randomUUID();
  await tx.insert(walletTransactions).values({
    id: txId, walletId, tenantId, type,
    amount: amount.toFixed(2),
    balanceBefore: before.toFixed(2),
    balanceAfter: after.toFixed(2),
    currency: wallet.currency,
    orderId: opts.orderId,
    escrowTxId: opts.escrowTxId,
    description: opts.description,
    reference: opts.reference,
    metadata: opts.metadata,
    createdAt: new Date(),
  });

  if (type === "escrow_credit") {
    await tx.update(merchantWallets).set({
      escrowBalance: sql`${merchantWallets.escrowBalance} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "escrow_release") {
    await tx.update(merchantWallets).set({
      escrowBalance: sql`GREATEST(${merchantWallets.escrowBalance} - ${amount.toFixed(2)}, 0)`,
      availableBalance: sql`${merchantWallets.availableBalance} + ${amount.toFixed(2)}`,
      totalEarned: sql`${merchantWallets.totalEarned} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "escrow_refund") {
    await tx.update(merchantWallets).set({
      escrowBalance: sql`GREATEST(${merchantWallets.escrowBalance} - ${amount.toFixed(2)}, 0)`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "float_income") {
    await tx.update(merchantWallets).set({
      availableBalance: sql`${merchantWallets.availableBalance} + ${amount.toFixed(2)}`,
      totalEarned: sql`${merchantWallets.totalEarned} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));
  } else if (type === "fee_deduction") {
    // The fee portion moves OUT of the merchant's escrow balance (the merchant
    // was only ever credited the net amount to availableBalance, so it must NOT
    // be debited again) and is credited to the deterministic platform fee
    // wallet so platform revenue is tracked as real money.
    await tx.update(merchantWallets).set({
      escrowBalance: sql`GREATEST(${merchantWallets.escrowBalance} - ${amount.toFixed(2)}, 0)`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, walletId));

    const platform = await getOrCreatePlatformFeeWallet(tx);
    const pWallet = await lockWalletRow(tx, platform.id);
    await tx.insert(walletTransactions).values({
      id: crypto.randomUUID(),
      walletId: platform.id,
      tenantId: PLATFORM_FEE_TENANT_ID,
      // wallet_tx_type enum has no "fee_credit" value (no schema change
      // allowed); the credit is labelled via description + metadata.
      type: "float_income",
      amount: amount.toFixed(2),
      balanceBefore: pWallet.availableBalance.toFixed(2),
      balanceAfter: (pWallet.availableBalance + amount).toFixed(2),
      currency: pWallet.currency,
      orderId: opts.orderId,
      escrowTxId: opts.escrowTxId,
      description: `Platform fee collected${opts.description ? ` — ${opts.description}` : ""}`,
      reference: opts.reference,
      metadata: { ...opts.metadata, source: "platform_fee" },
      createdAt: new Date(),
    });
    await tx.update(merchantWallets).set({
      availableBalance: sql`${merchantWallets.availableBalance} + ${amount.toFixed(2)}`,
      totalEarned: sql`${merchantWallets.totalEarned} + ${amount.toFixed(2)}`,
      updatedAt: new Date(),
    }).where(eq(merchantWallets.id, platform.id));
  }
  // NOTE: "withdrawal" is handled by requestWithdrawal with an atomic
  // conditional debit — it never goes through this helper.
  return txId;
}

/**
 * Standalone ledger write: wraps the read + insert + balance update in a single
 * SQL transaction so concurrent calls serialize on the wallet row lock.
 */
async function recordWalletTx(
  db: Db,
  walletId: string,
  tenantId: string,
  type: WalletTxType,
  amount: number,
  opts: { orderId?: string; escrowTxId?: string; description?: string; reference?: string; metadata?: Record<string, unknown> },
) {
  return db.transaction(async (tx) => recordWalletTxInTx(tx, walletId, tenantId, type, amount, opts));
}

// ─── Atomic escrow release helper ─────────────────────────────────────────────
/**
 * Atomically transition an escrow to settled (PSP) or release_instructed (PSSP)
 * via a single guarded UPDATE ... WHERE id AND state IN (<allowed>). The wallet
 * is credited ONLY when exactly one row transitioned, inside the same DB
 * transaction — concurrent double-release is impossible.
 */
export async function settleEscrowAtomic(
  db: Db,
  escrowId: string,
  opts: { autoConfirmed: boolean; allowedFromStates: string[]; descriptionPrefix?: string },
): Promise<{ transitioned: boolean; newState?: "settled" | "release_instructed"; escrow?: EscrowTransaction }> {
  const cfg = await getEscrowConfig(db);
  const now = new Date();
  return db.transaction(async (tx) => {
    const targetState = cfg.custodyMode === "psp" ? "settled" : "release_instructed";
    const transitioned = await tx.update(escrowTransactions).set({
      state: targetState,
      buyerConfirmedAt: opts.autoConfirmed ? null : now,
      autoConfirmed: opts.autoConfirmed,
      ...(targetState === "settled"
        ? { settledAt: now }
        : {
            releaseInstructedAt: now,
            bankRef: `ESCROW-REL-${escrowId.slice(0, 8).toUpperCase()}-${Date.now()}`,
          }),
      updatedAt: now,
    }).where(and(
      eq(escrowTransactions.id, escrowId),
      inArray(escrowTransactions.state, opts.allowedFromStates as ("payment_received" | "escrow_held" | "delivery_confirmed" | "release_instructed" | "settled" | "dispute_raised" | "dispute_resolved" | "refunded" | "expired")[]),
    )).returning();

    if (transitioned.length !== 1) {
      // No row matched the state guard — someone else already transitioned it.
      return { transitioned: false };
    }
    const escrow = transitioned[0];

    if (cfg.custodyMode === "psp") {
      const wallet = await getOrCreateWallet(tx, escrow.tenantId, "psp");
      const netAmount = parseFloat(escrow.netMerchantAmount);
      const fee = parseFloat(escrow.platformFee);
      const releaseTxId = await recordWalletTxInTx(tx, wallet.id, escrow.tenantId, "escrow_release", netAmount, {
        orderId: escrow.orderId, escrowTxId: escrow.id,
        description: `${opts.descriptionPrefix ?? "Settlement"} for order ${escrow.orderId}`,
      });
      if (fee > 0) {
        await recordWalletTxInTx(tx, wallet.id, escrow.tenantId, "fee_deduction", fee, {
          orderId: escrow.orderId, escrowTxId: escrow.id,
          description: `Platform fee for order ${escrow.orderId}`,
        });
      }
      const [final] = await tx.update(escrowTransactions).set({ merchantWalletTxId: releaseTxId, updatedAt: new Date() })
        .where(eq(escrowTransactions.id, escrow.id))
        .returning();
      return { transitioned: true, newState: targetState, escrow: final ?? escrow };
    }
    return { transitioned: true, newState: targetState, escrow };
  });
}

// ─── Atomic escrow refund helper (full + partial) ─────────────────────────────
/**
 * Refund an escrow (fully or partially) with the row locked for the whole
 * read-check-write. Partial refunds keep the escrow in its current state and
 * accumulate metadata.refundedAmount; only a full refund flips state to
 * "refunded". Never refunds more than the remaining (not-yet-refunded) amount
 * and never touches settled / refunded / release_instructed escrows.
 */
export async function refundEscrowAtomic(
  db: Db,
  escrowId: string,
  opts: { reason: string; refundAmount?: number },
): Promise<{ success: boolean; fullRefund: boolean; refundedAmount: number; totalRefunded: number; remaining: number; escrow?: EscrowTransaction; error?: string }> {
  const fail = (error: string, remaining = 0, totalRefunded = 0) =>
    ({ success: false, fullRefund: false, refundedAmount: 0, totalRefunded, remaining, error });
  const cfg = await getEscrowConfig(db);
  return db.transaction(async (tx) => {
    // Lock the escrow row for the whole read-check-write.
    const locked = await tx.execute(sql`SELECT id FROM escrow_transactions WHERE id = ${escrowId} FOR UPDATE`);
    if ((locked as unknown as unknown[]).length === 0) return fail("Escrow not found");
    const [escrow] = await tx.select().from(escrowTransactions).where(eq(escrowTransactions.id, escrowId));
    if (!escrow) return fail("Escrow not found");

    // Defense in depth: never refund a settled / already-refunded / released escrow.
    if (["settled", "refunded", "release_instructed", "expired"].includes(escrow.state)) {
      return fail(`Cannot refund from state: ${escrow.state}`);
    }

    const total = parseFloat(escrow.amount);
    const priorMeta = (escrow.metadata ?? {}) as Record<string, unknown>;
    const alreadyRefunded = parseFloat(String(priorMeta.refundedAmount ?? "0")) || 0;
    const remaining = Math.round((total - alreadyRefunded) * 100) / 100;
    if (remaining <= 0) return fail("Escrow has already been fully refunded", 0, alreadyRefunded);

    const refundAmt = opts.refundAmount ?? remaining;
    if (!(refundAmt > 0)) return fail("Refund amount must be positive", remaining, alreadyRefunded);
    if (refundAmt > remaining + 0.004) {
      return fail(`Refund amount ${refundAmt.toFixed(2)} exceeds remaining escrow balance ${remaining.toFixed(2)}`, remaining, alreadyRefunded);
    }

    const totalRefunded = Math.round((alreadyRefunded + refundAmt) * 100) / 100;
    const fullRefund = totalRefunded >= total - 0.004;
    const newRemaining = fullRefund ? 0 : Math.round((total - totalRefunded) * 100) / 100;
    const now = new Date();

    // Guarded state update FIRST: full refund → "refunded"; partial refund keeps
    // the current state and only accumulates metadata.refundedAmount. If the
    // guard fails we return before any wallet write (nothing to roll back).
    const transitioned = await tx.update(escrowTransactions).set({
      state: fullRefund ? "refunded" : escrow.state,
      refundedAt: fullRefund ? now : escrow.refundedAt,
      metadata: { ...priorMeta, refundedAmount: totalRefunded.toFixed(2) },
      updatedAt: now,
    }).where(and(
      eq(escrowTransactions.id, escrowId),
      sql`${escrowTransactions.state} NOT IN ('settled', 'refunded', 'release_instructed', 'expired')`,
    )).returning();

    if (transitioned.length !== 1) {
      return fail("Escrow state changed concurrently; refund aborted", remaining, alreadyRefunded);
    }

    // Wallet refund only after exactly one row transitioned.
    if (cfg.custodyMode === "psp") {
      const wallet = await getOrCreateWallet(tx, escrow.tenantId, "psp");
      await recordWalletTxInTx(tx, wallet.id, escrow.tenantId, "escrow_refund", refundAmt, {
        orderId: escrow.orderId, escrowTxId: escrow.id,
        description: `${fullRefund ? "Refund" : "Partial refund"}: ${opts.reason}`,
      });
    }
    return { success: true, fullRefund, refundedAmount: refundAmt, totalRefunded, remaining: newRemaining, escrow: transitioned[0] };
  });
}

// ─── Wallet top-up credit (provider-confirmed) ────────────────────────────────
/**
 * Credit a merchant wallet for a COMPLETED wallet_topup payment intent.
 * Idempotent: the credit is claimed atomically by stamping
 * metadata.creditedAt in a conditional UPDATE — a second call (webhook retry,
 * reconciliation run) is a no-op.
 */
export async function creditWalletTopUp(db: Db, paymentIntentId: string): Promise<{ credited: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      UPDATE payment_intents
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{creditedAt}', to_jsonb(now()::text), true),
          updated_at = now()
      WHERE id = ${paymentIntentId}
        AND status = 'completed'
        AND metadata->>'type' = 'wallet_topup'
        AND metadata->>'walletId' IS NOT NULL
        AND metadata->>'creditedAt' IS NULL
      RETURNING id, tenant_id, amount, metadata
    `);
    const intent = (claimed as unknown as Record<string, unknown>[])[0];
    if (!intent) return { credited: false, reason: "Not a completed, uncredited wallet top-up" };

    const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
    const walletId = String(metadata.walletId);
    const tenantId = String(intent.tenant_id);
    const amount = parseFloat(String(intent.amount));
    if (!(amount > 0)) return { credited: false, reason: "Invalid top-up amount" };

    // wallet_tx_type enum has no "topup_credit" value (no schema change
    // allowed); the credit is labelled via description + metadata.source.
    await recordWalletTxInTx(tx, walletId, tenantId, "float_income", amount, {
      description: `Wallet top-up confirmed (payment intent ${String(intent.id).slice(0, 8)}…)`,
      reference: `TOPUP-CREDIT-${String(intent.id).slice(0, 12)}`,
      metadata: { source: "wallet_topup", paymentIntentId: String(intent.id) },
    });
    return { credited: true };
  });
}

// ─── Escrow Router ────────────────────────────────────────────────────────────
export const escrowRouter = router({

  // Get platform escrow config
  getConfig: protectedProcedure.query(async () => {
    const db = await getDb();
    return getEscrowConfig(db);
  }),

  // Update escrow config (admin only)
  setConfig: adminProcedure
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

  // Create escrow hold when payment is confirmed.
  // A hold can ONLY be created against a verified completed payment for the
  // order, and the hold amount is derived server-side from that payment — never
  // from the client — so escrow balances can never be minted out of thin air.
  createHold: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      tenantId: z.string(),
      customerId: z.string().optional(),
      // Optional sanity bound; the actual hold amount always comes from the
      // verified payment, not from this value.
      amount: z.number().positive().optional(),
      currency: z.string().default("NGN"),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // Only the tenant that owns the order (or an admin) may create a hold.
      assertTenantAccess(ctx.user, input.tenantId);
      const cfg = await getEscrowConfig(db);

      // Idempotency check
      if (input.idempotencyKey) {
        const [existing] = await db.select().from(escrowTransactions)
          .where(eq(escrowTransactions.idempotencyKey, input.idempotencyKey));
        if (existing) return existing;
      }

      // Require a verified completed payment for this order.
      const [completedIntent] = await db.select().from(paymentIntents)
        .where(and(
          eq(paymentIntents.orderId, input.orderId),
          eq(paymentIntents.tenantId, input.tenantId),
          eq(paymentIntents.status, "completed"),
        ))
        .orderBy(desc(paymentIntents.completedAt))
        .limit(1);
      const [completedTx] = completedIntent ? [undefined] : await db.select().from(paymentTransactions)
        .where(and(
          eq(paymentTransactions.orderId, input.orderId),
          eq(paymentTransactions.tenantId, input.tenantId),
          inArray(paymentTransactions.status, ["completed", "success"]),
        ))
        .orderBy(desc(paymentTransactions.paidAt))
        .limit(1);

      const verifiedPayment = completedIntent ?? completedTx;
      if (!verifiedPayment) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `No completed payment found for order ${input.orderId} — an escrow hold cannot be created before payment is confirmed`,
        });
      }
      // Server-side amount derivation: the hold amount IS the verified payment
      // amount. A client-supplied amount may only act as a sanity bound.
      const holdAmount = parseFloat(verifiedPayment.amount);
      if (!(holdAmount > 0)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Completed payment has an invalid amount" });
      }
      if (input.amount != null && holdAmount < input.amount - 0.004) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Requested hold ₦${input.amount.toFixed(2)} exceeds the verified payment amount ₦${holdAmount.toFixed(2)}`,
        });
      }

      const feeRate = parseFloat(cfg.platformFeeRate);
      const fee = holdAmount * feeRate;
      const netMerchant = holdAmount - fee;
      const buyerDeadline = new Date(Date.now() + cfg.buyerConfirmWindowHours * 3600 * 1000);

      const id = crypto.randomUUID();
      await db.insert(escrowTransactions).values({
        id,
        orderId: input.orderId,
        tenantId: input.tenantId,
        customerId: input.customerId,
        amount: holdAmount.toFixed(2),
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
        const txId = await recordWalletTx(db, wallet.id, input.tenantId, "escrow_credit", holdAmount, {
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
        body: `₦${holdAmount.toLocaleString()} for order ${input.orderId} is now held in escrow pending delivery.`,
        metadata: { orderId: input.orderId, amount: holdAmount },
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
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) throw new Error("Escrow transaction not found");
      // Only the merchant that owns this escrow (their tenant) or an admin may
      // mark delivery confirmed — previously any authenticated user could
      // transition ANY tenant's escrow.
      assertTenantAccess(ctx.user, escrow.tenantId);
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

  // Buyer confirms receipt → release to merchant.
  // Authorization: the caller must be the order's buyer (matched via the
  // order's customer record) or an admin. The state transition is a single
  // guarded UPDATE — the wallet is credited only when exactly one row
  // transitioned, inside the same DB transaction (no double-release).
  buyerConfirm: protectedProcedure
    .input(z.object({ escrowId: z.string(), autoConfirmed: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) throw new TRPCError({ code: "NOT_FOUND", message: "Escrow not found" });

      // Only the buyer of this order (or an admin) can release the funds.
      await assertBuyerOrAdmin(db, ctx.user, escrow);
      // Only admins/system processes may mark a confirmation as automatic —
      // a merchant must never be able to self-release with autoConfirmed.
      const autoConfirmed = ctx.user.role === "admin" ? input.autoConfirmed : false;

      const result = await settleEscrowAtomic(db, input.escrowId, {
        autoConfirmed,
        // Buyer confirmation is only valid AFTER delivery has been confirmed —
        // releasing straight from escrow_held bypasses the delivery checkpoint.
        allowedFromStates: ["delivery_confirmed"],
      });
      if (!result.transitioned || !result.escrow) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot confirm in state: ${escrow.state} (delivery must be confirmed first, and the escrow must not already be released/settled)`,
        });
      }

      await db.update(orders).set({ status: "delivered", paymentStatus: "completed", updatedAt: new Date() })
        .where(eq(orders.id, escrow.orderId));

      // Fire-and-forget: notify merchant of settlement
      emitNotification({
        id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "escrow_settled",
        title: result.newState === "settled" ? "Funds Released to Your Wallet" : "Release Instruction Sent",
        body: result.newState === "settled"
          ? `₦${parseFloat(escrow.netMerchantAmount).toLocaleString()} from order ${escrow.orderId} released to your wallet.`
          : `Release instruction sent to bank for ₦${parseFloat(escrow.netMerchantAmount).toLocaleString()} from order ${escrow.orderId}.`,
        metadata: { orderId: escrow.orderId, escrowId: input.escrowId, netAmount: escrow.netMerchantAmount },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return result.escrow;
    }),

  // Bank confirms settlement (PSSP mode callback) — admin/system only
  bankSettlementConfirmed: adminProcedure
    .input(z.object({ escrowId: z.string(), bankRef: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const transitioned = await db.update(escrowTransactions).set({
        state: "settled",
        bankSettlementConfirmedAt: new Date(),
        settledAt: new Date(),
        bankRef: input.bankRef,
        updatedAt: new Date(),
      }).where(and(
        eq(escrowTransactions.id, input.escrowId),
        eq(escrowTransactions.state, "release_instructed"),
      )).returning();
      if (transitioned.length !== 1) {
        const [current] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, input.escrowId));
        throw new TRPCError({
          code: current ? "CONFLICT" : "NOT_FOUND",
          message: current
            ? `Cannot confirm bank settlement in state: ${current.state}`
            : "Escrow not found",
        });
      }
      return transitioned[0];
    }),

  // Initiate refund (dispute resolved in buyer's favour or manual refund).
  // Admin only. Atomic: the escrow row is locked for the whole read-check-write
  // and the wallet refund happens in the same transaction as the state change.
  // Partial refunds keep the escrow in its current state and accumulate
  // metadata.refundedAmount — the escrow only flips to "refunded" when the
  // full amount has been returned. Never refunds more than the remainder.
  initiateRefund: adminProcedure
    .input(z.object({
      escrowId: z.string(),
      reason: z.string(),
      refundAmount: z.number().positive().optional(), // partial refund support
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const result = await refundEscrowAtomic(db, input.escrowId, {
        reason: input.reason,
        refundAmount: input.refundAmount,
      });
      if (!result.success || !result.escrow) {
        const [current] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, input.escrowId));
        throw new TRPCError({
          code: current ? "CONFLICT" : "NOT_FOUND",
          message: result.error ?? "Refund failed",
        });
      }
      const escrow = result.escrow;

      // Only a full refund closes the order out.
      if (result.fullRefund) {
        await db.update(orders).set({ status: "refunded", paymentStatus: "refunded", updatedAt: new Date() })
          .where(eq(orders.id, escrow.orderId));
      }

      // Fire-and-forget: notify merchant of refund
      emitNotification({
        id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "escrow_refunded",
        title: result.fullRefund ? "Escrow Refunded to Buyer" : "Partial Refund Issued",
        body: result.fullRefund
          ? `Order ${escrow.orderId} refunded. ₦${result.refundedAmount.toLocaleString()} returned to buyer. Reason: ${input.reason}.`
          : `Order ${escrow.orderId} partially refunded: ₦${result.refundedAmount.toLocaleString()} returned to buyer (₦${result.remaining.toLocaleString()} remains in escrow). Reason: ${input.reason}.`,
        metadata: { orderId: escrow.orderId, escrowId: input.escrowId, amount: result.refundedAmount, totalRefunded: result.totalRefunded, remaining: result.remaining },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      return escrow;
    }),

  // Get escrow by order
  getByOrder: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.orderId, input.orderId))
        .orderBy(desc(escrowTransactions.createdAt));
      if (!escrow) return null;
      // Tenant isolation: merchants may only read their own tenant's escrows.
      assertTenantAccess(ctx.user, escrow.tenantId);
      return escrow;
    }),

  // List escrow transactions. Admins may list any tenant (or all); non-admin
  // callers are always restricted to their OWN tenant.
  listAll: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      state: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };
      // Tenant isolation: a non-admin can never list another tenant's escrows
      // (previously the tenantId filter was optional for any authenticated
      // caller — a cross-tenant read leak).
      let tenantId = input.tenantId;
      if (ctx.user.role !== "admin") {
        if (!ctx.user.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated with this account" });
        }
        if (tenantId && tenantId !== ctx.user.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only list your own tenant's escrows" });
        }
        tenantId = ctx.user.tenantId;
      }
      const conditions = [];
      if (tenantId) conditions.push(eq(escrowTransactions.tenantId, tenantId));
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

  // Platform-level stats (aggregates across ALL tenants — admin only)
  getStats: adminProcedure.query(async () => {
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
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];

      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) return [];
      // Tenant isolation: timeline leaks order/dispute/shipment detail.
      assertTenantAccess(ctx.user, escrow.tenantId);

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

  // ── Bulk state update (admin: batch release or refund) ────────────────────
  // Each row is transitioned via the same atomic helpers as the single-row
  // endpoints: guarded UPDATE ... WHERE state IN (...); the wallet is credited
  // or refunded only when exactly one row transitioned, in the same transaction.
  bulkUpdateState: adminProcedure
    .input(z.object({
      escrowIds: z.array(z.string()).min(1).max(100),
      action: z.enum(["release", "refund"]),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const rows = await db.select().from(escrowTransactions)
        .where(inArray(escrowTransactions.id, input.escrowIds));

      const results: { id: string; success: boolean; error?: string; newState?: string }[] = [];

      for (const escrow of rows) {
        try {
          if (input.action === "release") {
            const result = await settleEscrowAtomic(db, escrow.id, {
              autoConfirmed: true,
              // dispute_resolved is included so an admin can execute a
              // "full_release_to_merchant" dispute resolution via bulk release.
              allowedFromStates: ["delivery_confirmed", "escrow_held", "dispute_resolved"],
              descriptionPrefix: "Bulk settlement",
            });
            if (!result.transitioned || !result.escrow) {
              results.push({ id: escrow.id, success: false, error: `Cannot release from state: ${escrow.state}` });
              continue;
            }
            await db.update(orders).set({ status: "delivered", paymentStatus: "completed", updatedAt: new Date() })
              .where(eq(orders.id, escrow.orderId));
            emitNotification({
              id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "escrow_settled",
              title: "Funds Released (Bulk Operation)",
              body: `₦${parseFloat(escrow.netMerchantAmount).toLocaleString()} from order ${escrow.orderId} released via bulk operation.`,
              metadata: { orderId: escrow.orderId, escrowId: escrow.id },
              read: false, readAt: null, createdAt: new Date(),
            }).catch(() => {});
            results.push({ id: escrow.id, success: true, newState: result.newState });
          } else {
            // Refund (always the full remaining amount in bulk operations)
            const result = await refundEscrowAtomic(db, escrow.id, {
              reason: input.reason ?? "admin bulk operation",
            });
            if (!result.success) {
              results.push({ id: escrow.id, success: false, error: result.error ?? `Cannot refund from state: ${escrow.state}` });
              continue;
            }
            await db.update(orders).set({ status: "refunded", paymentStatus: "refunded", updatedAt: new Date() })
              .where(eq(orders.id, escrow.orderId));
            emitNotification({
              id: crypto.randomUUID(), tenantId: escrow.tenantId, type: "escrow_refunded",
              title: "Escrow Refunded (Bulk Operation)",
              body: `₦${result.refundedAmount.toLocaleString()} from order ${escrow.orderId} refunded via bulk operation.`,
              metadata: { orderId: escrow.orderId, escrowId: escrow.id },
              read: false, readAt: null, createdAt: new Date(),
            }).catch(() => {});
            results.push({ id: escrow.id, success: true, newState: "refunded" });
          }
        } catch (err) {
          results.push({ id: escrow.id, success: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      return { results, succeeded, failed };
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
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const cfg = await getEscrowConfig(db);

      // Tenant isolation: a caller can only raise a dispute on their OWN
      // tenant's escrow — previously any authenticated user could freeze ANY
      // tenant's escrow by guessing escrowTxId/orderId/tenantId.
      assertTenantAccess(ctx.user, input.tenantId);

      // Validate the escrow matches the claimed order/tenant (read-only check
      // for input sanity; the transition below is still atomic).
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowTxId));
      if (!escrow) throw new TRPCError({ code: "NOT_FOUND", message: "Escrow not found" });
      if (escrow.orderId !== input.orderId || escrow.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Escrow does not match the given order/tenant" });
      }

      // Freeze the escrow via a single guarded transition — disputes can only
      // be raised on ACTIVE escrows. Settled / refunded / release_instructed
      // escrows are terminal for disputes (prevents refund-after-settle).
      const transitioned = await db.update(escrowTransactions).set({
        state: "dispute_raised",
        updatedAt: new Date(),
      }).where(and(
        eq(escrowTransactions.id, input.escrowTxId),
        inArray(escrowTransactions.state, ["payment_received", "escrow_held", "delivery_confirmed"]),
      )).returning();
      if (transitioned.length !== 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot raise a dispute on an escrow in state: ${escrow.state}`,
        });
      }

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
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      // Tenant isolation: non-admins are always restricted to their own tenant
      // (previously omitting tenantId returned ALL tenants' disputes).
      let tenantId = input.tenantId;
      if (ctx.user.role !== "admin") {
        if (!ctx.user.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated with this account" });
        }
        if (tenantId && tenantId !== ctx.user.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only list your own tenant's disputes" });
        }
        tenantId = ctx.user.tenantId;
      }
      const conditions = [];
      if (tenantId) conditions.push(eq(escrowDisputes.tenantId, tenantId));
      if (input.status) conditions.push(eq(escrowDisputes.status, input.status as any));
      return db.select().from(escrowDisputes)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(escrowDisputes.createdAt))
        .limit(input.limit);
    }),

  getByOrder: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      // Tenant isolation: resolve the order's tenant and enforce ownership
      // (previously any authenticated user could read disputes for ANY order).
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId));
      if (!order) return [];
      assertTenantAccess(ctx.user, order.tenantId);
      return db.select().from(escrowDisputes)
        .where(eq(escrowDisputes.orderId, input.orderId))
        .orderBy(desc(escrowDisputes.createdAt));
    }),

  review: adminProcedure
    .input(z.object({
      disputeId: z.string(),
      resolution: z.enum(["full_release_to_merchant", "full_refund_to_buyer", "partial_refund", "no_action"]),
      refundAmount: z.number().optional(),
      resolverNotes: z.string().optional(),
      // Accepted for backwards compatibility but IGNORED — the resolver identity
      // is always derived from the authenticated admin session.
      resolvedBy: z.string().optional(),
      buyerEmail: z.string().email().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [dispute] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, input.disputeId));
      if (!dispute) throw new Error("Dispute not found");
      if (["resolved_merchant", "resolved_buyer"].includes(dispute.status)) {
        throw new TRPCError({ code: "CONFLICT", message: "Dispute is already resolved" });
      }

      // Server-side resolver identity — never trust the client.
      const resolvedBy = ctx.user.email ?? ctx.user.name ?? String(ctx.user.id);

      await db.update(escrowDisputes).set({
        status: "resolved_" + (input.resolution.includes("merchant") ? "merchant" : "buyer") as any,
        resolution: input.resolution,
        refundAmount: input.refundAmount?.toFixed(2),
        resolvedBy,
        resolverNotes: input.resolverNotes,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(escrowDisputes.id, input.disputeId));

      // Update escrow state — guarded so only a disputed escrow transitions.
      await db.update(escrowTransactions).set({
        state: "dispute_resolved",
        updatedAt: new Date(),
      }).where(and(
        eq(escrowTransactions.id, dispute.escrowTxId),
        eq(escrowTransactions.state, "dispute_raised"),
      ));

      const [updated] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, input.disputeId));
      // Fire-and-forget: notify merchant of dispute resolution
      emitNotification({
        id: crypto.randomUUID(), tenantId: dispute.tenantId, type: "dispute_resolved",
        title: "Dispute Resolved",
        body: `Dispute on order ${dispute.orderId} has been resolved. Outcome: ${input.resolution.replace(/_/g, " ")}.${input.resolverNotes ? ` Notes: ${input.resolverNotes}` : ""}`,
        metadata: { orderId: dispute.orderId, disputeId: input.disputeId, resolution: input.resolution },
        read: false, readAt: null, createdAt: new Date(),
      }).catch(() => {});
      // Fire-and-forget: send buyer email notification if email provided
      if (input.buyerEmail) {
        const outcomeLabel = input.resolution === "full_refund_to_buyer"
          ? "Full refund issued to you"
          : input.resolution === "full_release_to_merchant"
          ? "Payment released to merchant (no refund)"
          : input.resolution === "partial_refund"
          ? `Partial refund of ₦${(input.refundAmount ?? 0).toLocaleString()} issued to you`
          : "No action taken";
        const emailBody = [
          "Dear Customer,",
          "",
          `Your dispute for Order ${dispute.orderId} has been reviewed and resolved.`,
          "",
          `Outcome: ${outcomeLabel}`,
          input.resolverNotes ? `Notes from reviewer: ${input.resolverNotes}` : "",
          "",
          "If you have any questions, please contact our support team.",
          "",
          "Thank you for your patience.",
        ].filter(Boolean).join("\n");
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`,
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM ?? "disputes@whatsappcommerce.app",
            to: [input.buyerEmail],
            subject: `Dispute Resolution: Order ${dispute.orderId}`,
            text: emailBody,
          }),
        }).catch(() => {});
      }
      return updated!;
    }),
  // Escalate a dispute that has been open too long
  escalate: protectedProcedure
    .input(z.object({ disputeId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [dispute] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, input.disputeId));
      if (!dispute) throw new Error("Dispute not found");
      // Tenant isolation: only the dispute's own tenant (or an admin) may escalate.
      assertTenantAccess(ctx.user, dispute.tenantId);
      if ((dispute.status as string) === "escalated") throw new Error("Dispute is already escalated");
      await db.update(escrowDisputes).set({
        status: "escalated" as any,
        escalatedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(escrowDisputes.id, input.disputeId));
      const [updated] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, input.disputeId));
      // Notify the merchant
      const tpl = NOTIFICATION_TEMPLATES["dispute_escalated"]?.({ orderId: dispute.orderId, reason: input.reason ?? dispute.reason });
      if (tpl) {
        await emitNotification({
          tenantId: dispute.tenantId,
          type: "system",
          title: tpl.title,
          body: tpl.body,
        }).catch(() => {/* non-fatal */});
      }
      // Notify the platform owner (admin alert)
      await notifyOwner({
        title: `Dispute Escalated — Order ${dispute.orderId}`,
        content: `Dispute ID ${dispute.id} on tenant ${dispute.tenantId} has been escalated by ${ctx.user?.name ?? ctx.user?.openId ?? "admin"}. Reason: ${input.reason ?? dispute.reason ?? "unspecified"}.`,
      }).catch(() => {/* non-fatal */});
      return updated!;
    }),


  // Escalation SLA statistics for the admin dashboard (cross-tenant aggregate — admin only)
  escalationSlaStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { escalatedCount: 0, avgHoursToEscalation: null as number | null, openEscalatedCount: 0 };
    const disputes = await db.select().from(escrowDisputes);
    const escalated = disputes.filter(d => (d.status as string) === "escalated" || d.escalatedAt != null);
    const openEscalated = escalated.filter(d => (d.status as string) === "escalated");
    const withBoth = escalated.filter(d => d.escalatedAt != null);
    const avgMs = withBoth.length > 0
      ? withBoth.reduce((sum, d) => sum + (d.escalatedAt!.getTime() - d.createdAt.getTime()), 0) / withBoth.length
      : null;
    const avgHoursToEscalation = avgMs != null ? Math.round(avgMs / 3_600_000 * 10) / 10 : null;
    return { escalatedCount: escalated.length, avgHoursToEscalation, openEscalatedCount: openEscalated.length };
  }),

});

// ─── Wallet Router ────────────────────────────────────────────────────────────
export const walletRouter = router({

  getBalance: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      assertTenantAccess(ctx.user, input.tenantId);
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
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      assertTenantAccess(ctx.user, input.tenantId);
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
      // Client-supplied idempotency key — retries with the same reference
      // return the existing withdrawal instead of double-debiting.
      reference: z.string().max(128).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      assertTenantAccess(ctx.user, input.tenantId);
      const cfg = await getEscrowConfig(db);
      if (cfg.custodyMode !== "psp") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Withdrawals are only available under PSP licence mode" });
      const wallet = await getOrCreateWallet(db, input.tenantId, "psp");

      // Idempotency: same reference → return the existing pending withdrawal.
      const ref = input.reference ?? `WD-${Date.now()}-${input.tenantId.slice(0, 6).toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const [existing] = await db.select().from(walletTransactions)
        .where(and(eq(walletTransactions.walletId, wallet.id), eq(walletTransactions.reference, ref)));
      if (existing) {
        return {
          success: true,
          reference: ref,
          amount: parseFloat(existing.amount),
          status: ((existing.metadata as Record<string, unknown> | null)?.status as string) ?? "pending",
          duplicate: true,
        };
      }

      if (input.bankAccountNumber) {
        await db.update(merchantWallets).set({
          bankAccountName: input.bankAccountName,
          bankAccountNumber: input.bankAccountNumber,
          bankCode: input.bankCode,
          updatedAt: new Date(),
        }).where(eq(merchantWallets.id, wallet.id));
      }

      await db.transaction(async (tx) => {
        // Atomic conditional debit — the balance check and the debit are a
        // single UPDATE, so concurrent withdrawals can never double-spend and
        // the balance can never go negative (no GREATEST masking).
        const debited = await tx.execute(sql`
          UPDATE merchant_wallets
          SET available_balance = available_balance - ${input.amount.toFixed(2)}::numeric,
              total_withdrawn = total_withdrawn + ${input.amount.toFixed(2)}::numeric,
              updated_at = now()
          WHERE id = ${wallet.id}
            AND available_balance >= ${input.amount.toFixed(2)}::numeric
          RETURNING available_balance
        `);
        const row = (debited as unknown as Record<string, unknown>[])[0];
        if (!row) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "INSUFFICIENT_FUNDS: available balance is too low for this withdrawal" });
        }
        const after = parseFloat(String(row.available_balance));
        const before = after + input.amount;
        // The withdrawal is recorded as PENDING — it is only paid out after a
        // separate admin approval / payout step (tracked via metadata.status).
        await tx.insert(walletTransactions).values({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          tenantId: input.tenantId,
          type: "withdrawal",
          amount: input.amount.toFixed(2),
          balanceBefore: before.toFixed(2),
          balanceAfter: after.toFixed(2),
          currency: wallet.currency,
          description: `Withdrawal to ${input.bankAccountNumber ?? "bank account"} (pending approval)`,
          reference: ref,
          metadata: {
            status: "pending",
            bankAccountName: input.bankAccountName ?? null,
            bankAccountNumber: input.bankAccountNumber ?? null,
            bankCode: input.bankCode ?? null,
          },
          createdAt: new Date(),
        });
      });

      return { success: true, reference: ref, amount: input.amount, status: "pending" as const, duplicate: false };
    }),

  // Platform-wide wallet stats (aggregates across ALL tenants — admin only)
  getStats: adminProcedure.query(async () => {
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
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      assertTenantAccess(ctx.user, input.tenantId);
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
  // Top up / deposit funds into a merchant wallet.
  // Creates a REAL payment_intent via the configured provider (same pattern as
  // payment.ts initiate). The wallet is NOT credited here — credit only happens
  // after the provider callback confirms the payment (payment intent → completed,
  // reconciled via metadata.type = "wallet_topup" + metadata.walletId).
  topUp: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      amount: z.number().positive(),
      note: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      assertTenantAccess(ctx.user, input.tenantId);
      const wallet = await getOrCreateWallet(db, input.tenantId, "psp");

      // A real top-up requires a configured payment provider — never fake success.
      const provider: "paystack" | "flutterwave" | null = ENV.paystackSecretKey
        ? "paystack"
        : ENV.flwSecretKey
          ? "flutterwave"
          : null;
      if (!provider) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No payment provider configured (set PAYSTACK_SECRET_KEY or FLW_SECRET_KEY). " +
            "Wallet top-up cannot be initiated without a real provider.",
        });
      }

      const paymentIntentId = crypto.randomUUID();
      const ref = `TOPUP-${Date.now()}-${input.tenantId.slice(0, 6).toUpperCase()}`;
      const baseMetadata: Record<string, unknown> = {
        type: "wallet_topup",
        walletId: wallet.id,
        note: input.note ?? null,
      };

      // payment_intents.orderId / customerId are NOT NULL. A top-up has no order
      // and the merchant funds their own wallet, so we scope by wallet/tenant id.
      await db.insert(paymentIntents).values({
        id: paymentIntentId,
        tenantId: input.tenantId,
        orderId: wallet.id,
        customerId: input.tenantId,
        amount: input.amount.toFixed(2),
        currency: wallet.currency ?? "NGN",
        provider,
        status: "pending",
        providerPaymentId: ref,
        idempotencyKey: `wallet-topup:${ref}`,
        metadata: baseMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Initialize the transaction with the provider to get a real payment URL.
      let paymentUrl: string | null = null;
      try {
        if (provider === "paystack") {
          const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
            method: "POST",
            headers: { Authorization: `Bearer ${ENV.paystackSecretKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              email: `wallet-${input.tenantId.replace(/[^a-zA-Z0-9]/g, "")}@wa.commerce`,
              amount: Math.round(input.amount * 100),
              currency: wallet.currency ?? "NGN",
              reference: ref,
              metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, type: "wallet_topup" },
              callback_url: `${ENV.appUrl}/api/webhooks/paystack/callback`,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!psRes.ok) throw new Error(`Paystack initialization failed: ${await psRes.text()}`);
          const psData = await psRes.json() as { status: boolean; data: { authorization_url: string } };
          if (!psData.status) throw new Error("Paystack returned status=false");
          paymentUrl = psData.data.authorization_url;
        } else {
          const fwRes = await fetch("https://api.flutterwave.com/v3/payments", {
            method: "POST",
            headers: { Authorization: `Bearer ${ENV.flwSecretKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              tx_ref: ref,
              amount: input.amount,
              currency: wallet.currency ?? "NGN",
              redirect_url: `${ENV.appUrl}/api/webhooks/flutterwave/callback`,
              customer: { email: `wallet-${input.tenantId.replace(/[^a-zA-Z0-9]/g, "")}@wa.commerce` },
              meta: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, type: "wallet_topup" },
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!fwRes.ok) throw new Error(`Flutterwave initialization failed: ${await fwRes.text()}`);
          const fwData = await fwRes.json() as { status: string; data: { link: string } };
          paymentUrl = fwData.data.link;
        }
      } catch (err: any) {
        // Mark the intent failed — never leave a pending intent for a top-up
        // that was never initialized with the provider.
        await db.update(paymentIntents)
          .set({ status: "failed", failureReason: err.message, updatedAt: new Date() })
          .where(eq(paymentIntents.id, paymentIntentId));
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Wallet top-up initiation failed: ${err.message}`,
        });
      }

      await db.update(paymentIntents)
        .set({ metadata: { ...baseMetadata, paymentUrl }, updatedAt: new Date() })
        .where(eq(paymentIntents.id, paymentIntentId));

      // Wallet credit remains PENDING until the provider webhook confirms payment.
      return {
        success: true,
        reference: ref,
        amount: input.amount,
        paymentIntentId,
        paymentUrl,
        status: "pending",
      };
    }),

  /**
   * Reconcile wallet top-ups: find completed payment intents with
   * metadata.type = "wallet_topup" that have not been credited yet and credit
   * them. Idempotent (creditWalletTopUp claims each intent atomically via
   * metadata.creditedAt), so it is safe to run on a schedule. Admin/system only.
   */
  reconcileTopUps: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db.execute(sql`
        SELECT id FROM payment_intents
        WHERE status = 'completed'
          AND metadata->>'type' = 'wallet_topup'
          AND metadata->>'walletId' IS NOT NULL
          AND metadata->>'creditedAt' IS NULL
        ORDER BY created_at ASC
        LIMIT ${input?.limit ?? 100}
      `);
      const pending = rows as unknown as { id: string }[];
      let credited = 0;
      const errors: { id: string; error: string }[] = [];
      for (const row of pending) {
        try {
          const r = await creditWalletTopUp(db, row.id);
          if (r.credited) credited++;
        } catch (err) {
          errors.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { scanned: pending.length, credited, errors };
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
      // Accepted for backwards compatibility but IGNORED — the uploader
      // identity is always derived from the authenticated session.
      uploadedBy: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // Tenant isolation: attachments may only be added to the caller's own
      // tenant's escrows.
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) throw new TRPCError({ code: "NOT_FOUND", message: "Escrow not found" });
      assertTenantAccess(ctx.user, escrow.tenantId);
      const uploadedBy = ctx.user.name ?? ctx.user.email ?? String(ctx.user.id);
      let fileUrl: string | undefined;
      let fileKey: string | undefined;
      if (input.attachmentType === "document" && input.fileBase64 && input.filename) {
        const buffer = Buffer.from(input.fileBase64, "base64");
        // Strip any path components from the client-supplied filename so the
        // storage key can never escape its escrow-scoped prefix.
        const safeFilename = input.filename.replace(/[/\\]/g, "_").replace(/^\.+/, "_").slice(0, 255);
        const key = `escrow-attachments/${input.escrowId}/${input.eventId}/${Date.now()}-${safeFilename}`;
        const result = await storagePut(key, buffer, input.mimeType ?? "application/octet-stream");
        fileUrl = result.url;
        fileKey = result.key;
      }
      const id = crypto.randomUUID();
      await db.insert(escrowTimelineAttachments).values({
        id, escrowId: input.escrowId, eventId: input.eventId,
        attachmentType: input.attachmentType,
        fileUrl, fileKey, filename: input.filename, mimeType: input.mimeType,
        note: input.note, uploadedBy, createdAt: new Date(),
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
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      // Tenant isolation: attachments may only be read for the caller's own
      // tenant's escrows.
      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, input.escrowId));
      if (!escrow) return [];
      assertTenantAccess(ctx.user, escrow.tenantId);
      const conditions: any[] = [eq(escrowTimelineAttachments.escrowId, input.escrowId)];
      if (input.eventId) conditions.push(eq(escrowTimelineAttachments.eventId, input.eventId));
      return db.select().from(escrowTimelineAttachments)
        .where(and(...conditions))
        .orderBy(escrowTimelineAttachments.createdAt);
    }),
});
