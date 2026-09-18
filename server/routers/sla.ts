import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { escrowSlaConfig, escrowTransactions, escrowDisputes, orders, customers } from "../../drizzle/schema";
import { eq, isNull, and, or, inArray, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { emitNotification } from "./notifications";
import { settleEscrowAtomic, refundEscrowAtomic } from "./escrow";
import { notifyOwner } from "../_core/notification";
import { writeAuditLog } from "./audit";

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
  if (!db) return { scanned: 0, warned: 0, overdue: 0, settled: 0, skippedDisputed: 0, skippedUndelivered: 0, skippedCourierUnverified: 0, refunded: 0, staleEscrowPrompted: 0, merchantNoShipRefunded: 0 };

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
  // === W45 money-scheduled (PAY-22) ===
  let staleEscrowPrompted = 0;
  let merchantNoShipRefunded = 0;
  // === END W45 money-scheduled ===

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
      const {
        executeProviderRefund, verifyOrderRefund, honestOrderRefundStatus, honestRefundVocabulary, recordRefundAttempt,
      } = await import("../services/payments/refunds");
      const amountCents = Math.round(parseFloat(String(escrow.amount)) * 100);

      // ── W38 (PAY-2) verify-FIRST: a prior attempt may have timed out AFTER
      // the provider accepted the refund. Ask the provider before retrying —
      // never blindly re-issue money movement.
      if (order) {
        const verify = await verifyOrderRefund(db, { tenantId: escrow.tenantId, orderId: escrow.orderId! });
        if (verify.state === "exists") {
          await recordRefundAttempt(db, {
            tenantId: escrow.tenantId,
            orderId: escrow.orderId!,
            provider: verify.provider || "paystack",
            providerRef: verify.refundReference,
            idempotencyKey: `verify:${escrow.id}`,
            amountCents,
            currency: order.currency ?? "NGN",
            status: "verified_existing",
          });
          const existing: import("../services/payments/refunds").ProviderRefundOutcome = {
            executed: true,
            status: verify.status === "processed" ? "processed" : "pending",
            provider: verify.provider || undefined,
            refundReference: verify.refundReference,
          };
          await db.update(escrowTransactions).set({
            metadata: {
              ...sweepMeta,
              refundSweepRequired: false,
              providerRefundOnly: false,
              providerRefundFailed: false,
              providerRefundError: null,
              providerRefundVocabulary: honestRefundVocabulary(existing),
              providerRefundReference: verify.refundReference ?? null,
              providerRefundVerifiedExisting: true,
              providerRefundCompletedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          }).where(eq(escrowTransactions.id, escrow.id));
          await db.update(orders).set({ paymentStatus: honestOrderRefundStatus(existing), updatedAt: new Date() })
            .where(eq(orders.id, order.id));
          continue;
        }
        if (verify.state === "unknown") {
          // Fail CLOSED: the provider status check itself failed — do NOT
          // retry a possibly-accepted refund. Try again on the next scan.
          console.error(`[sla-scan] provider-refund verify inconclusive for escrow ${escrow.id}: ${verify.error} — NOT retrying blindly`);
          continue;
        }
        // "not_found": the provider has no refund recorded — safe to issue.
      }

      // ── W38 (PAY-2) attempt cap + dead-letter: bounded retries, then an
      // explicit dead-letter (flag cleared, alert raised) instead of an
      // infinite every-scan retry loop.
      const { refundAttempts } = await import("../../drizzle/schema");
      const priorAttempts = order
        ? (await db.select({ id: refundAttempts.id }).from(refundAttempts)
            .where(and(eq(refundAttempts.orderId, escrow.orderId!), eq(refundAttempts.tenantId, escrow.tenantId)))).length
        : 0;
      const REFUND_SWEEP_MAX_ATTEMPTS = 5;
      if (priorAttempts >= REFUND_SWEEP_MAX_ATTEMPTS) {
        await db.update(escrowTransactions).set({
          metadata: {
            ...sweepMeta,
            refundSweepRequired: false,
            providerRefundOnly: false,
            providerRefundDeadLettered: true,
            providerRefundError: `dead-lettered after ${priorAttempts} provider refund attempts`,
            providerRefundVocabulary: "refund_failed",
          },
          updatedAt: new Date(),
        }).where(eq(escrowTransactions.id, escrow.id));
        console.error(`[sla-scan] DEAD-LETTER provider refund for escrow ${escrow.id} (order ${escrow.orderId}) after ${priorAttempts} attempts — manual intervention required; no further automatic retries`);
        continue;
      }

      const outcome = order
        ? await executeProviderRefund(db, {
            tenantId: escrow.tenantId,
            orderId: escrow.orderId!,
            amountCents,
            currency: order.currency ?? "NGN",
            reason: `Provider-refund sweep for escrow ${escrow.id} (flagged at order cancellation)`,
          })
        : { executed: false as const, status: "no_provider_refund" as const, error: "order not found" };
      if (outcome.status === "failed") {
        // Ambiguous (timeout) failures are NOT retried on the next scan until
        // the provider verify above reports not_found — the verify-first
        // guard runs before every attempt.
        console.error(`[sla-scan] provider-refund sweep failed for escrow ${escrow.id}: ${outcome.error}${outcome.ambiguous ? " (AMBIGUOUS — verify-before-retry on next scan)" : " — will retry"}`);
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

        // === W45 money-scheduled (PAY-22): stale-escrow queue =============
        // Paid-but-never-shipped orders used to sit here forever, locking
        // buyer funds. Now: (a) the BUYER gets a "confirm or dispute" prompt
        // on BOTH channels (sendCustomerText: telegram via channelSender when
        // linked, else the byte-identical WA path), deduped 24h via
        // metadata.staleEscrowPromptAt (claimed BEFORE send — no double
        // prompt); (b) a merchant-no-ship auto-refund path returns the
        // buyer's money once the deadline is breached beyond the grace
        // window (config-gated MERCHANT_NO_SHIP_AUTO_REFUND_ENABLED, audited).
        const stale = await handleStaleEscrow(db, escrow, order, slaDeadline);
        staleEscrowPrompted += stale.prompted;
        merchantNoShipRefunded += stale.refunded;
        refunded += stale.refunded;
        // === END W45 money-scheduled (PAY-22) ===
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

  return { scanned: activeEscrows.length, warned, overdue, settled, skippedDisputed, skippedUndelivered, skippedCourierUnverified, refunded, staleEscrowPrompted, merchantNoShipRefunded };
}

// === W45 money-scheduled (PAY-21/PAY-22) ====================================
// Config gates (read per-call so ops can toggle without a reboot):
//  - MERCHANT_NO_SHIP_AUTO_REFUND_ENABLED (default "true") — PAY-22 refund leg
//  - MERCHANT_NO_SHIP_GRACE_HOURS        (default 72)       — breach duration
//      beyond the buyer-confirm deadline before a never-shipped paid order is
//      auto-refunded to the buyer.
//  - STALE_ESCROW_PROMPT_ENABLED         (default "true")   — buyer prompt leg
//  - DISPUTE_AUTO_RESOLVE_ENABLED        (default "true")   — PAY-21 resolve leg
//  - DISPUTE_AUTO_RESOLVE_GRACE_HOURS    (default 72)       — grace after the
//      merchant response deadline before buyer-favour auto-resolution.
export function merchantNoShipAutoRefundEnabled(): boolean {
  return (process.env.MERCHANT_NO_SHIP_AUTO_REFUND_ENABLED ?? "true") === "true";
}
export function merchantNoShipGraceMs(): number {
  const h = parseInt(process.env.MERCHANT_NO_SHIP_GRACE_HOURS ?? "72", 10);
  return Math.max(1, Number.isFinite(h) ? h : 72) * 3600_000;
}
export function staleEscrowPromptEnabled(): boolean {
  return (process.env.STALE_ESCROW_PROMPT_ENABLED ?? "true") === "true";
}
export function disputeAutoResolveEnabled(): boolean {
  return (process.env.DISPUTE_AUTO_RESOLVE_ENABLED ?? "true") === "true";
}
export function disputeAutoResolveGraceMs(): number {
  const h = parseInt(process.env.DISPUTE_AUTO_RESOLVE_GRACE_HOURS ?? "72", 10);
  return Math.max(1, Number.isFinite(h) ? h : 72) * 3600_000;
}

/** Order statuses where the merchant has NEVER shipped (buyer funds locked). */
const NEVER_SHIPPED_ORDER_STATUSES = ["pending", "confirmed", "processing", "partially_fulfilled"];
/** Buyer confirm-or-dispute prompt re-send dedupe window. */
const STALE_ESCROW_REPROMPT_MS = 24 * 3600_000;

type SlaDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Resolve the buyer's WhatsApp phone for an order (customers.whatsappPhone). */
async function buyerPhoneForOrder(db: SlaDb, orderId: string | null): Promise<string | null> {
  if (!orderId) return null;
  const [o] = await db.select({ customerId: orders.customerId, tenantId: orders.tenantId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) return null;
  const [c] = await db.select({ whatsappPhone: customers.whatsappPhone }).from(customers).where(eq(customers.id, o.customerId)).limit(1);
  if (c?.whatsappPhone) return c.whatsappPhone;
  // Chat-originated orders may store the buyer's PHONE DIGITS as customerId
  // rather than the customers.id UUID — fall back to a digits match.
  const digits = String(o.customerId ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  const [c2] = await db.select({ whatsappPhone: customers.whatsappPhone }).from(customers)
    .where(and(
      eq(customers.tenantId, o.tenantId),
      sql`regexp_replace(${customers.whatsappPhone}, '\D', '', 'g') = ${digits}`,
    )).limit(1);
  return c2?.whatsappPhone ?? null;
}

/**
 * PAY-22 stale-escrow handling for one overdue, undelivered escrow.
 * Returns { prompted, refunded } counters. Money moves ONLY through the
 * hardened refundEscrowAtomic + provider-refund leg (mirrors the cancelled-
 * order branch above); every state change is audited.
 */
async function handleStaleEscrow(
  db: SlaDb,
  escrow: typeof escrowTransactions.$inferSelect,
  order: { id: string; status: string; currency: string | null } | undefined,
  slaDeadline: Date,
): Promise<{ prompted: number; refunded: number }> {
  let prompted = 0;
  let refunded = 0;
  const meta = (escrow.metadata ?? {}) as Record<string, unknown>;
  const overdueMs = Date.now() - new Date(slaDeadline).getTime();
  const neverShipped = !!order && NEVER_SHIPPED_ORDER_STATUSES.includes(order.status) && escrow.state === "escrow_held";

  // ── (b) merchant-no-ship auto-refund (terminal — runs first) ──────────
  if (neverShipped && overdueMs >= merchantNoShipGraceMs() && merchantNoShipAutoRefundEnabled()) {
    const refund = await refundEscrowAtomic(db, escrow.id, {
      reason: `Merchant no-ship: order ${escrow.orderId} never shipped ${Math.floor(overdueMs / 3600_000)}h past the buyer-confirmation deadline — stale-escrow auto-refund to buyer`,
    });
    if (refund.success) {
      refunded++;
      // Provider leg (PSP custody) — same honest-vocabulary pattern as the
      // cancelled-order branch; failure flags the provider-refund sweep.
      const { executeProviderRefund, honestOrderRefundStatus } = await import("../services/payments/refunds");
      const providerOutcome = escrow.orderId
        ? await executeProviderRefund(db, {
            tenantId: escrow.tenantId,
            orderId: escrow.orderId,
            amountCents: Math.round(refund.refundedAmount * 100),
            currency: order?.currency ?? "NGN",
            reason: `Merchant-no-ship stale-escrow auto-refund for order ${escrow.orderId}`,
          })
        : { executed: false as const, status: "no_provider_refund" as const, error: "no order" };
      if (providerOutcome.status === "failed") {
        const cur = (escrow.metadata ?? {}) as Record<string, unknown>;
        await db.update(escrowTransactions).set({
          metadata: {
            ...cur,
            refundSweepRequired: true,
            providerRefundOnly: true,
            providerRefundFailed: true,
            providerRefundError: providerOutcome.error ?? "unknown",
          },
          updatedAt: new Date(),
        }).where(eq(escrowTransactions.id, escrow.id));
        console.error(`[sla-scan] merchant-no-ship provider refund FAILED for escrow ${escrow.id}: ${providerOutcome.error} — flagged for provider-refund sweep`);
      }
      if (escrow.orderId) {
        await db.update(orders).set({ paymentStatus: honestOrderRefundStatus(providerOutcome), updatedAt: new Date() })
          .where(eq(orders.id, escrow.orderId));
      }
      await writeAuditLog({
        actorId: "system", actorRole: "system",
        action: "escrow.merchant_no_ship_auto_refund",
        entityType: "escrow_transaction", entityId: escrow.id, tenantId: escrow.tenantId,
        summary: `Merchant-no-ship auto-refund of ${refund.refundedAmount.toFixed(2)} for escrow ${escrow.id} (order ${escrow.orderId ?? "unknown"}, never shipped, ${Math.floor(overdueMs / 3600_000)}h past deadline)`,
        after: { refundedAmount: refund.refundedAmount, providerRefund: providerOutcome.status },
      }).catch(() => {});
      await notifyOwner({
        title: `Merchant no-ship AUTO-REFUND executed (escrow ${escrow.id.slice(0, 8)})`,
        content: `Escrow ${escrow.id} (order ${escrow.orderId ?? "unknown"}, tenant ${escrow.tenantId}) was never shipped and stayed undelivered ${Math.floor(overdueMs / 3600_000)}h past the buyer-confirmation deadline. The buyer was auto-refunded ${refund.refundedAmount.toFixed(2)} ${order?.currency ?? "NGN"} (provider leg: ${providerOutcome.status}).`,
      }).catch(() => {});
      const buyerPhone = await buyerPhoneForOrder(db, escrow.orderId).catch(() => null);
      if (buyerPhone) {
        const { sendCustomerText } = await import("../services/channelParity");
        await sendCustomerText(escrow.tenantId, buyerPhone, "refund",
          `Your order ${escrow.orderId ?? ""} was never shipped by the merchant, so we have refunded your payment of ${refund.refundedAmount.toFixed(2)} ${order?.currency ?? "NGN"}. Sorry for the trouble.`,
          { notifType: "merchant_no_ship_refund", orderId: escrow.orderId }).catch(() => {});
      }
      await emitNotification({
        tenantId: escrow.tenantId, type: "escrow_refunded",
        title: "Escrow Auto-Refunded (Merchant No-Ship)",
        body: `Order #${escrow.orderId ?? escrow.id.slice(0, 8)} was never shipped; the buyer was auto-refunded ${refund.refundedAmount.toLocaleString()} after the no-ship grace window.`,
        metadata: { escrowId: escrow.id, autoRefund: true, merchantNoShip: true },
      });
    } else {
      console.error(`[sla-scan] merchant-no-ship auto-refund failed for escrow ${escrow.id}: ${refund.error}`);
    }
    return { prompted, refunded };
  }

  // ── (a) buyer "confirm or dispute" prompt (BOTH channels, deduped) ─────
  if (staleEscrowPromptEnabled()) {
    const lastPrompt = typeof meta.staleEscrowPromptAt === "string" ? Date.parse(meta.staleEscrowPromptAt) : 0;
    if (Date.now() - lastPrompt >= STALE_ESCROW_REPROMPT_MS) {
      // Claim-before-send: exactly one prompter wins the metadata marker.
      const marker = new Date().toISOString();
      const won = await db.update(escrowTransactions)
        .set({
          metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ staleEscrowPromptAt: marker })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(escrowTransactions.id, escrow.id),
          inArray(escrowTransactions.state, ["escrow_held", "delivery_confirmed"]),
          sql`COALESCE(metadata->>'staleEscrowPromptAt', '') = ${typeof meta.staleEscrowPromptAt === "string" ? meta.staleEscrowPromptAt : ""}`,
        ))
        .returning({ id: escrowTransactions.id });
      if (won.length === 1) {
        const buyerPhone = await buyerPhoneForOrder(db, escrow.orderId).catch(() => null);
        if (buyerPhone) {
          const { sendCustomerText } = await import("../services/channelParity");
          await sendCustomerText(escrow.tenantId, buyerPhone, "escrow_stale_prompt",
            `Your order ${escrow.orderId ?? ""} is taking longer than expected. If you have received your items, please CONFIRM receipt in this chat so we can release payment to the merchant. If not, reply DISPUTE to open a dispute and freeze the payment. If we do not hear from you and the merchant never ships, your payment is automatically refunded after the protection window.`,
            { notifType: "stale_escrow_prompt", orderId: escrow.orderId }).catch(() => {});
          prompted++;
        }
      }
    }
  }
  return { prompted, refunded };
}

// ─── PAY-21: dispute merchant-response-deadline sweep ────────────────────────
export interface DisputeSweepSummary {
  scanned: number;
  escalated: number;
  autoResolvedBuyer: number;
  resolveFailed: number;
  autoResolveEnabled: boolean;
}

/**
 * Sweep escrow_disputes.merchantResponseDeadline (previously write-only):
 *  1. open/under_review disputes past the merchant deadline → ESCALATED
 *     (guarded claim, audit row, tenant + ops notifications). No money moves.
 *  2. escalated disputes still unanswered after the grace window →
 *     auto-resolved BUYER-FAVOUR (full refund) — config-gated by
 *     DISPUTE_AUTO_RESOLVE_ENABLED and executed through the SAME hardened
 *     refund path as the admin dispute review (refundEscrowAtomic + provider
 *     leg for PSP custody), audited as resolvedBy 'system:merchant-no-response'.
 * Invoked by the /api/scheduled/dispute-deadline-sweep cron route.
 */
export async function runDisputeDeadlineSweep(now: Date = new Date()): Promise<DisputeSweepSummary> {
  const summary: DisputeSweepSummary = {
    scanned: 0, escalated: 0, autoResolvedBuyer: 0, resolveFailed: 0,
    autoResolveEnabled: disputeAutoResolveEnabled(),
  };
  const db = await getDb();
  if (!db) return summary;

  // ── 1. Escalate past-deadline disputes ──────────────────────────────────
  const due = await db.select().from(escrowDisputes)
    .where(and(
      inArray(escrowDisputes.status, ["open", "under_review"]),
      lt(escrowDisputes.merchantResponseDeadline, now),
    ))
    .limit(100);
  summary.scanned = due.length;
  for (const d of due) {
    // Claim-before-notify: exactly one sweeper escalates each dispute.
    const won = await db.update(escrowDisputes)
      .set({ status: "escalated", escalatedAt: now, updatedAt: now })
      .where(and(
        eq(escrowDisputes.id, d.id),
        inArray(escrowDisputes.status, ["open", "under_review"]),
      ))
      .returning({ id: escrowDisputes.id });
    if (won.length !== 1) continue;
    summary.escalated++;
    await writeAuditLog({
      actorId: "system", actorRole: "system",
      action: "dispute.escalated",
      entityType: "escrow_dispute", entityId: d.id, tenantId: d.tenantId,
      summary: `Dispute ${d.id} (order ${d.orderId}) escalated: merchant did not respond by the ${d.merchantResponseDeadline?.toISOString() ?? "?"} deadline`,
      after: { status: "escalated", reason: d.reason, raisedBy: d.raisedBy },
    }).catch(() => {});
    await emitNotification({
      tenantId: d.tenantId, type: "dispute_opened",
      title: "Dispute Escalated — Response Deadline Missed",
      body: `The dispute on order ${d.orderId} was escalated because no merchant response arrived by the deadline. Unanswered disputes auto-resolve in the buyer's favour after the grace window.`,
      metadata: { orderId: d.orderId, disputeId: d.id, escrowTxId: d.escrowTxId },
    }).catch(() => {});
    await notifyOwner({
      title: `Dispute escalated — merchant no response (order ${d.orderId.slice(0, 8)})`,
      content: `Dispute ${d.id} (tenant ${d.tenantId}, order ${d.orderId}, reason ${d.reason}) passed its merchant-response deadline unanswered and was escalated. Buyer-favour auto-resolution ${summary.autoResolveEnabled ? "applies after the grace window" : "is DISABLED by config"} — review recommended.`,
    }).catch(() => {});
  }

  // ── 2. Auto-resolve buyer-favour after grace (config-gated) ────────────
  if (!summary.autoResolveEnabled) return summary;
  const graceCutoff = new Date(now.getTime() - disputeAutoResolveGraceMs());
  const staleEscalated = await db.select().from(escrowDisputes)
    .where(and(
      eq(escrowDisputes.status, "escalated"),
      lt(escrowDisputes.merchantResponseDeadline, graceCutoff),
    ))
    .limit(50);
  for (const d of staleEscalated) {
    try {
      // Money FIRST through the guarded atomic helper (FOR UPDATE + state
      // transition), then claim the dispute row. An escrow already refunded
      // (concurrent admin resolve) is treated as terminal-success so the
      // dispute row still closes honestly.
      const refund = await refundEscrowAtomic(db, d.escrowTxId, {
        reason: `Dispute ${d.id} auto-resolved buyer-favour: merchant no response within deadline + grace`,
      });
      const alreadyRefunded = !refund.success && /already been fully refunded|Cannot refund from state: refunded/.test(refund.error ?? "");
      if (!refund.success && !alreadyRefunded) {
        summary.resolveFailed++;
        console.error(`[dispute-sweep] auto-resolve refund failed for dispute ${d.id}: ${refund.error}`);
        continue;
      }
      const claimed = await db.update(escrowDisputes)
        .set({
          status: "resolved_buyer",
          resolution: "full_refund_to_buyer",
          resolvedBy: "system:merchant-no-response",
          resolverNotes: `Auto-resolved: merchant did not respond by ${d.merchantResponseDeadline?.toISOString() ?? "?"} plus ${disputeAutoResolveGraceMs() / 3600_000}h grace`,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(eq(escrowDisputes.id, d.id), eq(escrowDisputes.status, "escalated")))
        .returning({ id: escrowDisputes.id });
      if (claimed.length !== 1) continue; // concurrent human resolve won

      let providerStatus = "not_applicable";
      if (!alreadyRefunded && refund.success) {
        const [escrowRow] = await db.select().from(escrowTransactions).where(eq(escrowTransactions.id, d.escrowTxId)).limit(1);
        // Provider leg runs unconditionally (same as the cancelled-order SLA
        // branch): executeProviderRefund itself decides whether a real PSP
        // refund exists ("no_provider_refund" otherwise) — never gate on a
        // custody-mode guess.
        const { executeProviderRefund, honestOrderRefundStatus } = await import("../services/payments/refunds");
        const providerOutcome = await executeProviderRefund(db, {
          tenantId: d.tenantId,
          orderId: d.orderId,
          amountCents: Math.round(refund.refundedAmount * 100),
          currency: escrowRow?.currency ?? "NGN",
          reason: `Dispute ${d.id} auto-resolved full_refund_to_buyer (merchant no response)`,
        });
        providerStatus = providerOutcome.status;
        if (providerOutcome.status === "failed" && escrowRow) {
          const cur = (escrowRow.metadata ?? {}) as Record<string, unknown>;
          await db.update(escrowTransactions).set({
            metadata: { ...cur, refundSweepRequired: true, providerRefundOnly: true, providerRefundFailed: true, providerRefundError: providerOutcome.error ?? "unknown" },
            updatedAt: new Date(),
          }).where(eq(escrowTransactions.id, escrowRow.id));
        }
        await db.update(orders).set({ paymentStatus: honestOrderRefundStatus(providerOutcome), updatedAt: new Date() })
          .where(eq(orders.id, d.orderId));
        await db.update(orders).set({ status: "refunded", updatedAt: new Date() }).where(eq(orders.id, d.orderId));
      }
      summary.autoResolvedBuyer++;
      await writeAuditLog({
        actorId: "system", actorRole: "system",
        action: "dispute.auto_resolved_buyer",
        entityType: "escrow_dispute", entityId: d.id, tenantId: d.tenantId,
        summary: `Dispute ${d.id} (order ${d.orderId}) auto-resolved buyer-favour: merchant no response within deadline + grace; refund ${refund.success ? refund.refundedAmount.toFixed(2) : "already-refunded"} (provider: ${providerStatus})`,
        after: { status: "resolved_buyer", resolution: "full_refund_to_buyer", providerRefund: providerStatus },
      }).catch(() => {});
      await emitNotification({
        tenantId: d.tenantId, type: "dispute_resolved",
        title: "Dispute Auto-Resolved (Buyer Favour)",
        body: `The dispute on order ${d.orderId} was auto-resolved in the buyer's favour — no merchant response within the deadline + grace window. A full refund was executed.`,
        metadata: { orderId: d.orderId, disputeId: d.id, autoResolved: true },
      }).catch(() => {});
      const buyerPhone = await buyerPhoneForOrder(db, d.orderId).catch(() => null);
      if (buyerPhone && !alreadyRefunded) {
        const { sendCustomerText } = await import("../services/channelParity");
        await sendCustomerText(d.tenantId, buyerPhone, "refund",
          `Good news: your dispute on order ${d.orderId} was resolved in your favour because the merchant did not respond in time. A full refund${refund.success ? ` of ${refund.refundedAmount.toFixed(2)}` : ""} has been executed.`,
          { notifType: "dispute_auto_resolved", orderId: d.orderId }).catch(() => {});
      }
    } catch (err) {
      summary.resolveFailed++;
      console.error(`[dispute-sweep] auto-resolve failed for dispute ${d.id}:`, (err as Error)?.message);
    }
  }
  return summary;
}
// === END W45 money-scheduled (PAY-21/PAY-22) ===

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
