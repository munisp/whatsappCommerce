/**
 * === W31 scheduled-batch (Coder B) ===
 * `scheduledPayments` router — payment scheduling + batch payments.
 * Money-moving procedures (schedule / cancel / retry / batchPay) are
 * moneyProcedure-guarded (tenant owner|operator; analyst can never move
 * money); list is analyst-readable. Execution itself is performed ONLY by
 * the /api/scheduled/execute-payments cron route (claim-before-send engine
 * in server/services/scheduledPayments.ts) — these procedures never move
 * money inline except batchPay, which executes each item via the same
 * locked wallet-debit helper with per-item idempotency keys.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, moneyProcedure, analystProcedure } from "../_core/trpc";
import { getDb } from "../db";

const kindEnum = z.enum(["vendor_bill", "payout", "adhoc"]);
const recipientSchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  bankAccountNumber: z.string().max(20).optional(),
  bankCode: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
}).passthrough();

export const scheduledPaymentsRouter = router({
  /** Schedule a future wallet payment. Idempotent on idempotencyKey. */
  schedule: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      kind: kindEnum,
      targetId: z.string().max(64).optional(),
      recipient: recipientSchema.optional(),
      amountCents: z.number().int().positive().max(1_000_000_000_00),
      currency: z.string().length(3).optional(),
      executeAt: z.coerce.date(),
      idempotencyKey: z.string().max(160).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/scheduledPayments");
      const { payment, duplicate } = await svc.schedulePayment(db, {
        tenantId: input.tenantId,
        kind: input.kind,
        targetId: input.targetId ?? null,
        recipient: input.recipient ?? null,
        amountCents: input.amountCents,
        currency: input.currency ?? "NGN",
        executeAt: input.executeAt,
        idempotencyKey: input.idempotencyKey,
        createdBy: String(ctx.user.id),
      });
      return { id: payment.id, status: payment.status, executeAt: payment.executeAt, duplicate };
    }),

  /** Tenant-scoped list (analyst read-only allowed). */
  list: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["pending", "claimed", "executed", "failed", "cancelled", "insufficient_funds"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/scheduledPayments");
      const rows = await svc.listPayments(db, input.tenantId, { status: input.status, limit: input.limit });
      return rows.map((r) => ({
        id: r.id, kind: r.kind, targetId: r.targetId, recipient: r.recipient,
        amountCents: r.amountCents, currency: r.currency, executeAt: r.executeAt,
        status: r.status, attempts: r.attempts, lastError: r.lastError,
        idempotencyKey: r.idempotencyKey, createdAt: r.createdAt,
      }));
    }),

  /** Cancel a not-yet-executed payment. Executed rows refuse honestly. */
  cancel: moneyProcedure
    .input(z.object({ tenantId: z.string(), id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/scheduledPayments");
      try {
        const res = await svc.cancelPayment(db, input.tenantId, input.id);
        if (!res.cancelled && res.status === "executed") {
          throw new TRPCError({ code: "CONFLICT", message: "Payment already executed — the wallet ledger entry is committed and cannot be cancelled" });
        }
        if (!res.cancelled) {
          throw new TRPCError({ code: "CONFLICT", message: `Cannot cancel from status ${res.status}` });
        }
        return res;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        if ((err as Error)?.message?.startsWith("NOT_FOUND")) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Scheduled payment not found" });
        }
        throw err;
      }
    }),

  /**
   * Merchant retry after wallet top-up: resets insufficient_funds / failed
   * (non-dead-lettered) payments to pending for the next cron tick.
   */
  retry: moneyProcedure
    .input(z.object({ tenantId: z.string(), id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/scheduledPayments");
      try {
        const res = await svc.retryPayment(db, input.tenantId, input.id);
        if (!res.retried) {
          throw new TRPCError({ code: "CONFLICT", message: `Cannot retry: ${res.reason ?? `status ${res.status}`}` });
        }
        return res;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        if ((err as Error)?.message?.startsWith("NOT_FOUND")) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Scheduled payment not found" });
        }
        throw err;
      }
    }),

  /**
   * Batch payments: up to 50 targets under a single confirmation. Per-item
   * idempotency keys `batch:<batchId>:<idx>`; every item executes in its own
   * transaction so one failure never rolls back the others. Returns honest
   * per-item outcomes; the summary row lands in payment_batches.
   */
  batchPay: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      batchId: z.string().uuid().optional(),
      items: z.array(z.object({
        kind: kindEnum,
        targetId: z.string().max(64).optional(),
        recipient: recipientSchema.optional(),
        amountCents: z.number().int().positive().max(1_000_000_000_00),
        currency: z.string().length(3).optional(),
      })).min(1).max(50),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/scheduledPayments");
      try {
        return await svc.batchPay(db, {
          tenantId: input.tenantId,
          batchId: input.batchId,
          createdBy: String(ctx.user.id),
          items: input.items.map((it) => ({
            kind: it.kind,
            targetId: it.targetId ?? null,
            recipient: it.recipient ?? null,
            amountCents: it.amountCents,
            currency: it.currency ?? "NGN",
          })),
        });
      } catch (err) {
        const msg = (err as Error)?.message ?? "";
        if (msg.startsWith("BAD_REQUEST")) throw new TRPCError({ code: "BAD_REQUEST", message: msg });
        throw err;
      }
    }),
});
// === END W31 scheduled-batch ===
