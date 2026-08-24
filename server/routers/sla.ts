import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { escrowSlaConfig, escrowTransactions, escrowDisputes, orders } from "../../drizzle/schema";
import { eq, isNull, and, or, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { emitNotification } from "./notifications";
import { settleEscrowAtomic, refundEscrowAtomic } from "./escrow";
import { notifyOwner } from "../_core/notification";

// ─── SLA status helpers ───────────────────────────────────────────────────────
export type SlaStatus = "ok" | "warning" | "overdue" | "no_deadline";

export function computeSlaStatus(
  slaDeadline: Date | null | undefined,
  warningHours: number
): SlaStatus {
  if (!slaDeadline) return "no_deadline";
  const now = Date.now();
  const deadlineMs = new Date(slaDeadline).getTime();
  const warningMs = warningHours * 60 * 60 * 1000;
  if (now >= deadlineMs) return "overdue";
  if (now >= deadlineMs - warningMs) return "warning";
  return "ok";
}

export function computeCountdown(slaDeadline: Date | null | undefined): {
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
  isExpired: boolean;
} {
  if (!slaDeadline) return { hours: 0, minutes: 0, seconds: 0, totalSeconds: 0, isExpired: false };
  const diff = Math.max(0, new Date(slaDeadline).getTime() - Date.now());
  const totalSeconds = Math.floor(diff / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
    isExpired: diff === 0,
  };
}

// ─── Get effective SLA config for a tenant (falls back to platform default) ──
export async function getEffectiveSlaConfig(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tenantId: string) {
  // Try tenant-specific config first
  const tenantConfig = await db
    .select()
    .from(escrowSlaConfig)
    .where(eq(escrowSlaConfig.tenantId, tenantId));
  if (tenantConfig.length > 0) return tenantConfig[0];
  // Fall back to platform default (tenantId IS NULL)
  const defaultConfig = await db
    .select()
    .from(escrowSlaConfig)
    .where(isNull(escrowSlaConfig.tenantId));
  if (defaultConfig.length > 0) return defaultConfig[0];
  // Hard-coded fallback
  return { releaseDeadlineHours: 72, warningHours: 24, autoReleaseEnabled: true, tenantId: null };
}

// ─── Heartbeat: scan escrows for SLA breaches ─────────────────────────────────
// Invoked by the cron endpoint (caller auth is enforced at the HTTP layer).
// Auto-settlement goes through the SAME atomic helper as manual release:
// a guarded state transition + merchant wallet credit + wallet ledger entry in
// one DB transaction. Escrows with an open dispute are NEVER auto-settled and
// disputes are never auto-resolved.
export async function runSlaScan() {
  const db = await getDb();
  if (!db) return { scanned: 0, warned: 0, overdue: 0, settled: 0, skippedDisputed: 0, skippedUndelivered: 0, skippedCourierUnverified: 0, refunded: 0 };

  // Get all active escrows (held state) — plus any escrow flagged
  // metadata.refundSweepRequired (e.g. a refunded-internally escrow whose
  // PROVIDER refund leg failed at cancel time, verify-v1 #9). Flagged
  // escrows are handled by the sweep branch below and NEVER released.
  const activeEscrows = await db
    .select()
    .from(escrowTransactions)
    .where(or(
      inArray(escrowTransactions.state, ["escrow_held", "delivery_confirmed"]),
      sql`metadata->>'refundSweepRequired' = 'true'`,
    ));

  let warned = 0;
  let overdue = 0;
  let settled = 0;
  let skippedDisputed = 0;
  let skippedUndelivered = 0;
  let skippedCourierUnverified = 0;
  let refunded = 0;

  for (const escrow of activeEscrows) {
    // ── W30 hotfix (verify-v1 #9): provider-refund retry. The internal
    // wallet-ledger refund already happened (e.g. at order cancel); only the
    // PSP leg failed. Retry it here; keep the flag while the provider keeps
    // failing. This runs before any deadline/release logic and NEVER settles.
    const sweepMeta = (escrow.metadata ?? {}) as Record<string, unknown>;
    if (sweepMeta.refundSweepRequired === true && sweepMeta.providerRefundOnly === true) {
      const [order] = escrow.orderId
        ? await db.select({ id: orders.id, currency: orders.currency }).from(orders).where(eq(orders.id, escrow.orderId)).limit(1)
        : [undefined];
      const { executeProviderRefund, honestOrderRefundStatus, honestRefundVocabulary } = await import("../services/payments/refunds");
      const outcome = order
        ? await executeProviderRefund(db, {
            tenantId: escrow.tenantId,
            orderId: escrow.orderId!,
            amountCents: Math.round(parseFloat(String(escrow.amount)) * 100),
            currency: order.currency ?? "NGN",
            reason: `Provider-refund sweep for escrow ${escrow.id} (flagged at order cancellation)`,
          })
        : { executed: false as const, status: "no_provider_refund" as const, error: "order not found" };
      if (outcome.status === "failed") {
        console.error(`[sla-scan] provider-refund sweep failed for escrow ${escrow.id}: ${outcome.error} — will retry`);
        continue;
      }
      // Terminal (executed / queued / no provider path): clear the flag and
      // stamp the honest vocabulary + order payment status.
      await db.update(escrowTransactions).set({
        metadata: {
          ...sweepMeta,
          refundSweepRequired: false,
          providerRefundOnly: false,
          providerRefundFailed: false,
          providerRefundError: null,
          providerRefundVocabulary: honestRefundVocabulary(outcome),
          providerRefundReference: outcome.refundReference ?? null,
          providerRefundCompletedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, escrow.id));
      if (order) {
        await db.update(orders).set({ paymentStatus: honestOrderRefundStatus(outcome), updatedAt: new Date() })
          .where(eq(orders.id, order.id));
      }
      continue;
    }

    // The escrow's SLA clock is the buyer-confirmation deadline (the column
    // previously read, `slaDeadline`, does not exist on escrow_transactions).
    const slaDeadline = escrow.buyerConfirmDeadline as Date | null;
    if (!slaDeadline) continue;

    const config = await getEffectiveSlaConfig(db, escrow.tenantId);
    const status = computeSlaStatus(slaDeadline, config.warningHours ?? 24);

    if (status === "warning") {
      warned++;
      await emitNotification({
        tenantId: escrow.tenantId,
        type: "system",
        title: "Escrow Release Deadline Approaching",
        body: `Order #${escrow.orderId ?? escrow.id.slice(0, 8)} escrow will auto-release in less than ${config.warningHours} hours.`,
        metadata: { escrowId: escrow.id, slaDeadline: slaDeadline.toISOString() },
      });
    } else if (status === "overdue" && config.autoReleaseEnabled) {
      // NEVER auto-settle an escrow with an open dispute — and never
      // auto-resolve disputes. Skip it for human review.
      const [openDispute] = await db
        .select({ id: escrowDisputes.id })
        .from(escrowDisputes)
        .where(and(
          eq(escrowDisputes.escrowTxId, escrow.id),
          inArray(escrowDisputes.status, ["open", "under_review", "escalated"]),
        ))
        .limit(1);
      if (openDispute) {
        skippedDisputed++;
        continue;
      }

      // ── W30 (verify-v1 #6): NEVER auto-release money for an order that was
      // not actually delivered. The old scan looked only at escrow state, so
      // unshipped/cancelled orders were auto-paid to the merchant once the
      // payment-time deadline elapsed.
      const [order] = escrow.orderId
        ? await db.select({ id: orders.id, status: orders.status, currency: orders.currency }).from(orders).where(eq(orders.id, escrow.orderId)).limit(1)
        : [undefined];

      // Cancelled order → the buyer must get their money back, never the
      // merchant. Route through the hardened atomic refund helper.
      if (order?.status === "cancelled") {
        const refund = await refundEscrowAtomic(db, escrow.id, {
          reason: `Order ${escrow.orderId} was cancelled — SLA scan auto-refund to buyer`,
        });
        if (refund.success) {
          refunded++;
          // ── W30 hotfix (verify-v1 #9): internal ledger refund alone does
          // not return PSP-custodied money — execute the provider refund and
          // record the honest vocabulary (refunded / refund_initiated /
          // refund_recorded). On provider failure flag the escrow for the
          // provider-refund sweep (top of this scan) — never released.
          const { executeProviderRefund, honestOrderRefundStatus, honestRefundVocabulary } = await import("../services/payments/refunds");
          const providerOutcome = await executeProviderRefund(db, {
            tenantId: escrow.tenantId,
            orderId: escrow.orderId!,
            amountCents: Math.round(refund.refundedAmount * 100),
            currency: order?.currency ?? "NGN",
            reason: `Order ${escrow.orderId} cancelled — SLA scan auto-refund to buyer`,
          });
          const honestStatus = honestOrderRefundStatus(providerOutcome);
          await db.update(orders).set({ paymentStatus: honestStatus, updatedAt: new Date() })
            .where(eq(orders.id, escrow.orderId));
          if (providerOutcome.status === "failed") {
            const meta = (escrow.metadata ?? {}) as Record<string, unknown>;
            await db.update(escrowTransactions).set({
              metadata: {
                ...meta,
                refundSweepRequired: true,
                providerRefundOnly: true,
                providerRefundFailed: true,
                providerRefundError: providerOutcome.error ?? "unknown",
              },
              updatedAt: new Date(),
            }).where(eq(escrowTransactions.id, escrow.id));
            console.error(`[sla-scan] cancel-refund provider leg FAILED for escrow ${escrow.id}: ${providerOutcome.error} — flagged for provider-refund sweep`);
          }
          const vocab = honestRefundVocabulary(providerOutcome);
          await emitNotification({
            tenantId: escrow.tenantId,
            type: "escrow_refunded",
            title: "Escrow Refunded (Order Cancelled)",
            body: `Order #${escrow.orderId ?? escrow.id.slice(0, 8)} was cancelled; ₦${refund.refundedAmount.toLocaleString()} ${vocab === "refund_paid" ? "refunded to the buyer" : vocab === "refund_initiated" ? "refund initiated with the payment provider (queued)" : vocab === "refund_failed" ? "refund recorded internally — provider refund pending retry" : "recorded as refunded on the platform ledger (provider refund unavailable)"}.`,
            metadata: { escrowId: escrow.id, autoRefund: true, refundVocabulary: vocab },
          });
        } else {
          console.error(`[sla-scan] cancel-refund failed for escrow ${escrow.id}: ${refund.error}`);
        }
        continue;
      }

      // Escrows flagged for a refund sweep (e.g. cancel-time refund failure)
      // are retried here, never released.
      const escMeta = (escrow.metadata ?? {}) as Record<string, unknown>;
      if (escMeta.refundSweepRequired === true) {
        const refund = await refundEscrowAtomic(db, escrow.id, {
          reason: `Refund sweep for escrow ${escrow.id} (flagged at order cancellation)`,
        });
        if (refund.success) {
          refunded++;
          // W30 hotfix (verify-v1 #9): internal refund recovered — now run
          // the provider leg too (best-effort). If the provider fails, keep
          // the sweep flag (providerRefundOnly) for the next scan.
          const { executeProviderRefund, honestOrderRefundStatus, honestRefundVocabulary } = await import("../services/payments/refunds");
          const providerOutcome = escrow.orderId
            ? await executeProviderRefund(db, {
                tenantId: escrow.tenantId,
                orderId: escrow.orderId,
                amountCents: Math.round(refund.refundedAmount * 100),
                currency: order?.currency ?? "NGN",
                reason: `Refund sweep for escrow ${escrow.id} (flagged at order cancellation)`,
              })
            : { executed: false as const, status: "no_provider_refund" as const, error: "no order" };
          if (providerOutcome.status === "failed") {
            await db.update(escrowTransactions).set({
              metadata: { ...escMeta, refundSweepRequired: true, providerRefundOnly: true, providerRefundFailed: true, providerRefundError: providerOutcome.error ?? "unknown" },
              updatedAt: new Date(),
            }).where(eq(escrowTransactions.id, escrow.id));
            console.error(`[sla-scan] refund sweep provider leg failed for escrow ${escrow.id}: ${providerOutcome.error} — will retry`);
          } else {
            await db.update(escrowTransactions).set({
              metadata: {
                ...escMeta,
                refundSweepRequired: false,
                refundSweepCompletedAt: new Date().toISOString(),
                providerRefundVocabulary: honestRefundVocabulary(providerOutcome),
                providerRefundReference: providerOutcome.refundReference ?? null,
              },
              updatedAt: new Date(),
            }).where(eq(escrowTransactions.id, escrow.id));
          }
          if (escrow.orderId) {
            await db.update(orders).set({ paymentStatus: honestOrderRefundStatus(providerOutcome), updatedAt: new Date() })
              .where(eq(orders.id, escrow.orderId));
          }
        } else {
          console.error(`[sla-scan] refund sweep failed for escrow ${escrow.id}: ${refund.error}`);
        }
        continue;
      }

      // ── W30 hotfix (verify-v1 #11): escrow delivery was self-reported by a
      // mock/local/unverified courier in production — NEVER auto-settle.
      // Skip + alert; settlement requires a real buyer confirm or admin review.
      if (escMeta.buyerProtection === "courier_unverified") {
        skippedCourierUnverified++;
        await notifyOwner({
          title: `SLA auto-release BLOCKED — unverified courier (escrow ${escrow.id.slice(0, 8)})`,
          content: `Escrow ${escrow.id} (order ${escrow.orderId ?? "unknown"}, tenant ${escrow.tenantId}, state ${escrow.state}) breached its buyer-confirmation deadline, but its delivery confirmation came from a mock/local/unverified courier ("${escMeta.courierUnverifiedAt ? `flagged at ${escMeta.courierUnverifiedAt}` : "courier_unverified"}"). Auto-release was skipped. Require buyer confirmation or manual admin review before settling.`,
        }).catch(() => {/* non-fatal */});
        continue;
      }

      // Not delivered → SKIP and alert. An escrow in delivery_confirmed with
      // a non-delivered order is inconsistent too — skip either way unless
      // the order is recorded delivered.
      const delivered = order?.status === "delivered";
      if (!delivered) {
        skippedUndelivered++;
        await notifyOwner({
          title: `SLA auto-release BLOCKED — order not delivered (escrow ${escrow.id.slice(0, 8)})`,
          content: `Escrow ${escrow.id} (order ${escrow.orderId ?? "unknown"}, tenant ${escrow.tenantId}, state ${escrow.state}) breached its buyer-confirmation deadline but the order status is "${order?.status ?? "missing"}" — NOT delivered. Auto-release was skipped to protect the buyer. Investigate fulfilment or cancel/refund the order.`,
        }).catch(() => {/* non-fatal */});
        continue;
      }

      overdue++;
      // Atomic guarded release: state transition + merchant wallet credit +
      // wallet ledger entry in a single transaction (PSP mode). In PSSP mode
      // this issues the bank release instruction instead.
      const result = await settleEscrowAtomic(db, escrow.id, {
        autoConfirmed: true,
        allowedFromStates: ["escrow_held", "delivery_confirmed"],
        descriptionPrefix: "Auto-release (SLA deadline)",
      });
      if (!result.transitioned) continue; // state changed concurrently — skip

      settled++;
      await emitNotification({
        tenantId: escrow.tenantId,
        type: "escrow_settled",
        title: "Escrow Auto-Released (SLA Deadline)",
        body: `Order #${escrow.orderId ?? escrow.id.slice(0, 8)} escrow was automatically released after the ${config.releaseDeadlineHours}h SLA deadline.`,
        metadata: { escrowId: escrow.id, autoReleased: true },
      });
    }
  }

  return { scanned: activeEscrows.length, warned, overdue, settled, skippedDisputed, skippedUndelivered, skippedCourierUnverified, refunded };
}

// ─── tRPC router ─────────────────────────────────────────────────────────────
export const slaRouter = router({
  getConfig: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId;
    if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return getEffectiveSlaConfig(db, tenantId);
  }),

  updateConfig: protectedProcedure
    .input(z.object({
      releaseDeadlineHours: z.number().int().min(1).max(720),
      warningHours: z.number().int().min(1).max(168),
      autoReleaseEnabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const existing = await db
        .select()
        .from(escrowSlaConfig)
        .where(eq(escrowSlaConfig.tenantId, tenantId));

      if (existing.length > 0) {
        await db
          .update(escrowSlaConfig)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(escrowSlaConfig.tenantId, tenantId));
      } else {
        await db.insert(escrowSlaConfig).values({
          id: crypto.randomUUID(),
          tenantId,
          ...input,
        });
      }
      return { success: true };
    }),

  // Admin: get platform-wide SLA overview
  getPlatformOverview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { ok: [], warning: [], overdue: [] };

    const activeEscrows = await db
      .select()
      .from(escrowTransactions)
      .where(inArray(escrowTransactions.state, ["escrow_held", "delivery_confirmed"]));

    const ok: typeof activeEscrows = [];
    const warning: typeof activeEscrows = [];
    const overdue: typeof activeEscrows = [];

    for (const escrow of activeEscrows) {
      const slaDeadline = escrow.buyerConfirmDeadline as Date | null;
      const config = await getEffectiveSlaConfig(db, escrow.tenantId);
      const status = computeSlaStatus(slaDeadline, config.warningHours ?? 24);
      if (status === "overdue") overdue.push(escrow);
      else if (status === "warning") warning.push(escrow);
      else ok.push(escrow);
    }

    return {
      ok: ok.length,
      warning: warning.length,
      overdue: overdue.length,
      total: activeEscrows.length,
      warningItems: warning.slice(0, 10).map(e => ({
        id: e.id,
        orderId: e.orderId,
        tenantId: e.tenantId,
        amount: e.amount,
        slaDeadline: e.buyerConfirmDeadline,
      })),
      overdueItems: overdue.slice(0, 10).map(e => ({
        id: e.id,
        orderId: e.orderId,
        tenantId: e.tenantId,
        amount: e.amount,
        slaDeadline: e.buyerConfirmDeadline,
      })),
    };
  }),

  // Per-escrow SLA status (used by countdown component)
  getEscrowSlaStatus: protectedProcedure
    .input(z.object({ escrowId: z.string() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const escrows = await db
        .select()
        .from(escrowTransactions)
        .where(and(eq(escrowTransactions.id, input.escrowId), eq(escrowTransactions.tenantId, tenantId)));
      if (!escrows.length) throw new TRPCError({ code: "NOT_FOUND" });
      const escrow = escrows[0];
      const config = await getEffectiveSlaConfig(db, tenantId);
      const slaDeadline = escrow.buyerConfirmDeadline as Date | null;
      return {
        escrowId: escrow.id,
        slaDeadline,
        status: computeSlaStatus(slaDeadline, config.warningHours ?? 24),
        countdown: computeCountdown(slaDeadline),
        config,
      };
    }),
});
