/**
 * === W32 recurring-tiers (Coder B) ===
 * `recurringRules` router — CRUD for recurring bill/payment rules.
 * All mutations are moneyProcedure-guarded (a rule creates money-moving
 * payments on schedule; an analyst must never arm one); reads are
 * analyst-readable. Execution happens ONLY in the daily
 * /api/scheduled/recurring-run sweep (server/services/recurringRules.ts).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, moneyProcedure, analystProcedure } from "../_core/trpc";
import { getDb } from "../db";

const recipientSchema = z.object({
  name: z.string().max(200).optional(),
  vendorName: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  contact: z.record(z.string(), z.unknown()).optional(),
  bankAccountNumber: z.string().max(20).optional(),
  bankCode: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
}).passthrough();

function rethrow(err: unknown): never {
  const msg = (err as Error)?.message ?? "";
  if (msg.startsWith("NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "Recurring rule not found" });
  if (msg.startsWith("CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: msg.replace(/^CONFLICT:\s*/, "") });
  if (msg.startsWith("BAD_REQUEST")) throw new TRPCError({ code: "BAD_REQUEST", message: msg.replace(/^BAD_REQUEST:\s*/, "") });
  throw err;
}

export const recurringRulesRouter = router({
  /** Create a recurring rule (weekly | monthly). */
  create: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      kind: z.enum(["vendor_bill", "adhoc"]),
      recipient: recipientSchema.optional(),
      amountCents: z.number().int().positive().max(1_000_000_000_00),
      currency: z.string().length(3).optional(),
      cadence: z.enum(["weekly", "monthly"]),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      autoPayUnderCents: z.number().int().min(0).max(1_000_000_000_00).optional(),
      firstRunAt: z.coerce.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      try {
        const rule = await svc.createRule(db, {
          tenantId: input.tenantId,
          kind: input.kind,
          recipient: input.recipient ?? null,
          amountCents: input.amountCents,
          currency: input.currency ?? "NGN",
          cadence: input.cadence,
          dayOfMonth: input.dayOfMonth ?? null,
          autoPayUnderCents: input.autoPayUnderCents ?? 0,
          firstRunAt: input.firstRunAt ?? null,
          createdBy: String(ctx.user.id),
        });
        return { id: rule.id, status: rule.status, nextRunAt: rule.nextRunAt };
      } catch (err) { rethrow(err); }
    }),

  /** Tenant-scoped list (analyst read-only allowed). */
  list: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      const rows = await svc.listRules(db, input.tenantId, { status: input.status, limit: input.limit });
      return rows.map((r: any) => ({
        id: r.id, kind: r.kind, recipient: r.recipient, amountCents: r.amountCents,
        currency: r.currency, cadence: r.cadence, dayOfMonth: r.dayOfMonth,
        autoPayUnderCents: r.autoPayUnderCents, nextRunAt: r.nextRunAt,
        lastRunAt: r.lastRunAt, status: r.status, createdAt: r.createdAt,
      }));
    }),

  /** Single rule read (analyst). */
  get: analystProcedure
    .input(z.object({ tenantId: z.string(), id: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      try { return await svc.getRule(db, input.tenantId, input.id); } catch (err) { rethrow(err); }
    }),

  /** Edit amount / cadence / threshold / recipient / next run. */
  update: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      id: z.string().uuid(),
      amountCents: z.number().int().positive().max(1_000_000_000_00).optional(),
      cadence: z.enum(["weekly", "monthly"]).optional(),
      dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
      autoPayUnderCents: z.number().int().min(0).max(1_000_000_000_00).optional(),
      nextRunAt: z.coerce.date().optional(),
      recipient: recipientSchema.nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      const { tenantId, id, ...patch } = input;
      try { return await svc.updateRule(db, tenantId, id, patch); } catch (err) { rethrow(err); }
    }),

  /** Pause a rule — no further periods are created until resumed. */
  pause: moneyProcedure
    .input(z.object({ tenantId: z.string(), id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      try { return await svc.setRuleStatus(db, input.tenantId, input.id, "pause"); } catch (err) { rethrow(err); }
    }),

  /** Resume a paused rule. */
  resume: moneyProcedure
    .input(z.object({ tenantId: z.string(), id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      try { return await svc.setRuleStatus(db, input.tenantId, input.id, "resume"); } catch (err) { rethrow(err); }
    }),

  /** Cancel a rule — permanent; past payments stay paid honestly. */
  cancel: moneyProcedure
    .input(z.object({ tenantId: z.string(), id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const svc = await import("../services/recurringRules");
      try { return await svc.setRuleStatus(db, input.tenantId, input.id, "cancel"); } catch (err) { rethrow(err); }
    }),
});
// === END W32 recurring-tiers ===
