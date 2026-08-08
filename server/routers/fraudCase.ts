import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { fraudCases, FraudCase, merchantNotifications, NewFraudCase } from "../../drizzle/schema";
import { writeAuditLog } from "./audit";

/** Max filing attempts before a case is dead-lettered (DLQ). */
export const FRAUD_CASE_MAX_ATTEMPTS = 3;

/**
 * Pure state machine for one filing attempt — exported for tests.
 * attempts is the count BEFORE this attempt.
 */
export function resolveAttemptOutcome(opts: {
  success: boolean;
  attempts: number;
  maxAttempts?: number;
}): { status: "filed" | "failed" | "dead_letter"; attempts: number } {
  const max = opts.maxAttempts ?? FRAUD_CASE_MAX_ATTEMPTS;
  const attempts = opts.attempts + 1;
  if (opts.success) return { status: "filed", attempts };
  return { status: attempts >= max ? "dead_letter" : "failed", attempts };
}

/** Create a fraud case in the filing queue (called from the payment path). */
export async function createFraudCase(entry: Omit<NewFraudCase, "id" | "createdAt" | "updatedAt">): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.insert(fraudCases).values(entry).returning({ id: fraudCases.id });
  return row?.id ?? null;
}

/**
 * "File" a case through the notification/webhook path:
 *  1. Always emit a merchant notification (type=system) — the internal record.
 *  2. If AML_WEBHOOK_URL is configured, POST the filing there; a non-2xx
 *     response (or network error) fails the attempt so it can be retried.
 */
async function fileFraudCase(c: FraudCase): Promise<void> {
  const db = (await getDb())!;
  await db.insert(merchantNotifications).values({
    id: crypto.randomUUID(),
    tenantId: c.tenantId,
    type: "system",
    title: `Fraud case filed (${c.riskLevel} risk)`,
    body: `Case ${c.id}: fraud score ${c.fraudScore} on payment ${c.paymentIntentId ?? "n/a"} — suspicious activity report queued for compliance review.`,
    metadata: { fraudCaseId: c.id, fraudScore: c.fraudScore, riskLevel: c.riskLevel },
  });
  const webhookUrl = process.env.AML_WEBHOOK_URL;
  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "suspicious_activity_report",
        caseId: c.id,
        tenantId: c.tenantId,
        fraudScore: c.fraudScore,
        riskLevel: c.riskLevel,
        paymentIntentId: c.paymentIntentId,
        orderId: c.orderId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`AML webhook filing failed: HTTP ${res.status}`);
  }
}

export const fraudCaseRouter = router({
  list: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      status: z.enum(["pending", "filed", "failed", "dead_letter"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [];
      if (input.tenantId) conds.push(eq(fraudCases.tenantId, input.tenantId));
      if (input.status) conds.push(eq(fraudCases.status, input.status));
      return db.select().from(fraudCases)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(fraudCases.createdAt))
        .limit(input.limit);
    }),

  /**
   * Requeue failed filings (failed → pending). Uses a guarded UPDATE … WHERE
   * status='failed' so concurrent requeues are safe: only one wins the
   * transition, the other observes zero affected rows.
   */
  retryFailed: adminProcedure
    .input(z.object({ caseId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const updated = await db.update(fraudCases)
        .set({ status: "pending", lastError: null, updatedAt: new Date() })
        .where(and(eq(fraudCases.id, input.caseId), eq(fraudCases.status, "failed")))
        .returning({ id: fraudCases.id });
      if (!updated.length) {
        const [current] = await db.select({ status: fraudCases.status }).from(fraudCases)
          .where(eq(fraudCases.id, input.caseId)).limit(1);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Fraud case not found" });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Case is '${current.status}' — only 'failed' cases can be requeued`,
        });
      }
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "fraudCase.retryFailed",
        entityType: "fraud_case",
        entityId: input.caseId,
        summary: "Fraud case requeued for filing (failed → pending)",
        before: { status: "failed" },
        after: { status: "pending" },
      });
      return { ok: true as const, caseId: input.caseId, status: "pending" as const };
    }),

  /**
   * Manual filing override — admin only. (Pen-test target: a non-admin must
   * NOT be able to mark their own case filed; adminProcedure enforces this.)
   */
  markFiled: adminProcedure
    .input(z.object({ caseId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [before] = await db.select().from(fraudCases).where(eq(fraudCases.id, input.caseId)).limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Fraud case not found" });
      await db.update(fraudCases)
        .set({ status: "filed", filedAt: new Date(), updatedAt: new Date() })
        .where(eq(fraudCases.id, input.caseId));
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "fraudCase.markFiled",
        entityType: "fraud_case",
        entityId: input.caseId,
        tenantId: before.tenantId,
        summary: `Fraud case manually marked filed by admin ${ctx.user.id}`,
        before: { status: before.status },
        after: { status: "filed" },
      });
      return { ok: true as const };
    }),

  /**
   * Cron-processable queue drain (admin / scheduled invocation). Claims each
   * pending case with a guarded UPDATE (concurrent workers can't double-file),
   * then files it via the notification/webhook path with a retry counter and
   * dead-letters after FRAUD_CASE_MAX_ATTEMPTS failures.
   */
  processQueue: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(25) }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const pending = await db.select().from(fraudCases)
        .where(eq(fraudCases.status, "pending"))
        .orderBy(fraudCases.createdAt)
        .limit(input.limit);

      const results = { processed: 0, filed: 0, failed: 0, deadLettered: 0 };
      for (const c of pending) {
        // Atomic optimistic claim: increment attempts only if the row is still
        // pending with the attempt count we read — a concurrent worker that
        // already claimed it bumps attempts, so our guard matches zero rows
        // and we skip (no double-filing).
        const claimed = await db.update(fraudCases)
          .set({ attempts: c.attempts + 1, lastAttemptAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(fraudCases.id, c.id),
            eq(fraudCases.status, "pending"),
            eq(fraudCases.attempts, c.attempts),
          ))
          .returning({ id: fraudCases.id });
        if (!claimed.length) continue; // lost the race — another worker has it

        results.processed++;
        let outcome: ReturnType<typeof resolveAttemptOutcome>;
        let error: string | null = null;
        try {
          await fileFraudCase(c);
          outcome = resolveAttemptOutcome({ success: true, attempts: c.attempts });
        } catch (err: any) {
          error = err?.message ?? "filing failed";
          outcome = resolveAttemptOutcome({ success: false, attempts: c.attempts });
        }
        await db.update(fraudCases).set({
          status: outcome.status,
          attempts: outcome.attempts,
          lastError: error,
          ...(outcome.status === "filed" ? { filedAt: new Date() } : {}),
          updatedAt: new Date(),
        }).where(eq(fraudCases.id, c.id));

        if (outcome.status === "filed") results.filed++;
        else if (outcome.status === "dead_letter") results.deadLettered++;
        else results.failed++;

        await writeAuditLog({
          actorId: String(ctx.user.id),
          actorRole: ctx.user.role,
          action: "fraudCase.processQueue",
          entityType: "fraud_case",
          entityId: c.id,
          tenantId: c.tenantId,
          summary: `Filing attempt ${outcome.attempts}: ${outcome.status}${error ? ` (${error})` : ""}`,
          before: { status: "pending", attempts: c.attempts },
          after: { status: outcome.status, attempts: outcome.attempts },
        });
      }
      return results;
    }),
});
