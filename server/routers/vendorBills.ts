/**
 * W31 vendor-bills (Coder A) — tenant-guarded Vendor Bills AP inbox router.
 *
 * Payment actions (recordPayment) and state-changing mutations use
 * moneyProcedure (owner|operator — analyst is NEVER enough for money
 * movement); read-only surfaces (list/get/events) use analystProcedure.
 * Money flows through the post-W30 locked wallet helpers in
 * services/vendorBills.ts — FOR UPDATE lock, atomic conditional decrement,
 * unique payment_ref idempotency, honest partially_paid/INSUFFICIENT_FUNDS.
 */
import { z } from "zod";
import { and, desc, eq, gte, lte, like } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { analystProcedure, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { vendorBillEvents, vendorBills } from "../../drizzle/schema";
import {
  createVendorBill,
  recordVendorBillPayment,
  sweepOverdueVendorBills,
} from "../services/vendorBills";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const dateInput = z.union([z.string(), z.date()]).transform((v) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid date: ${v}` });
  return d;
});

/** Translate service-layer errors (code-tagged) into tRPC errors. */
function rethrow(err: any): never {
  if (err instanceof TRPCError) throw err;
  const code = err?.code === "NOT_FOUND" ? "NOT_FOUND"
    : err?.code === "CONFLICT" ? "CONFLICT"
    : "BAD_REQUEST";
  throw new TRPCError({ code, message: err?.message ?? String(err) });
}

export const vendorBillsRouter = router({
  /** Create a bill manually, or capture one from an image via the OCR pipeline. */
  create: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      vendorName: z.string().max(160).optional(),
      vendorContact: z.record(z.string(), z.unknown()).optional(),
      billNumber: z.string().max(64).optional(),
      description: z.string().max(2000).optional(),
      amountCents: z.number().int().positive().optional(),
      currency: z.string().length(3).optional(),
      issueDate: dateInput.optional(),
      dueDate: dateInput.optional(),
      captureSource: z.enum(["photo", "pdf", "whatsapp", "manual", "odoo"]).optional(),
      captureMediaKey: z.string().max(160).optional(),
      captureImage: z.object({
        base64: z.string().min(1),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      }).optional(),
      // === W33 tax-statements: OPTIONAL supplier tax capture ===
      vendorRef: z.string().max(128).optional(),
      taxProfile: z.object({
        taxId: z.string().max(64).optional(),
        taxIdType: z.enum(["tin", "vat", "cac", "nin", "other"]).optional(),
        countryCode: z.string().length(2).optional(),
        withholdingBps: z.number().int().min(0).max(10000).optional(),
        phone: z.string().max(32).optional(),
      }).optional(),
      // === END W33 tax-statements ===
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      try {
        const { tenantId, vendorRef, taxProfile, ...rest } = input;
        const created = await createVendorBill(db, { ...rest, tenantId, actor: String(ctx.user.id) });
        // === W33 tax-statements: OPTIONAL capture — when the caller passes
        // vendorRef/taxProfile the supplier profile is upserted (never
        // required) and the bill is stamped with the stable vendor ref so
        // annual statements aggregate under the same supplier identity.
        if (vendorRef || taxProfile) {
          try {
            const { upsertSupplierTaxProfile } = await import("../services/supplierTaxStatements");
            const { phone, ...tax } = taxProfile ?? {};
            await upsertSupplierTaxProfile(db, {
              tenantId,
              vendorName: created.bill.vendorName ?? vendorRef ?? "unknown",
              vendorRef: vendorRef ?? created.bill.vendorName ?? null,
              ...tax,
              metadata: phone ? { phone } : undefined,
              actor: String(ctx.user.id),
            });
            if (vendorRef) {
              const meta = { ...((created.bill.metadata as any) ?? {}), vendorRef };
              await db.update(vendorBills).set({ metadata: meta, updatedAt: new Date() })
                .where(and(eq(vendorBills.id, created.bill.id), eq(vendorBills.tenantId, tenantId)));
              (created.bill as any).metadata = meta;
            }
          } catch (capErr) {
            // Capture is advisory: never block a bill create on profile capture.
            console.error("[vendorBills.create] W33 tax-profile capture failed:", capErr);
          }
        }
        // === END W33 tax-statements ===
        return created;
      } catch (e) { rethrow(e); }
    }),

  /** List bills with status / due-window / vendor filters. Analyst read-only. */
  list: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["pending", "scheduled", "approved", "pending_approval", "paid", "partially_paid", "overdue", "cancelled"]).optional(),
      dueFrom: dateInput.optional(),
      dueTo: dateInput.optional(),
      vendor: z.string().max(160).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds: any[] = [eq(vendorBills.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(vendorBills.status, input.status));
      if (input.dueFrom) conds.push(gte(vendorBills.dueDate, input.dueFrom));
      if (input.dueTo) conds.push(lte(vendorBills.dueDate, input.dueTo));
      if (input.vendor) conds.push(like(vendorBills.vendorName, `%${input.vendor}%`));
      return db.select().from(vendorBills)
        .where(and(...conds))
        .orderBy(desc(vendorBills.createdAt))
        .limit(input.limit);
    }),

  /** Fetch one bill + its audit events. Analyst read-only. */
  get: analystProcedure
    .input(z.object({ tenantId: z.string(), billId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const [bill] = await db.select().from(vendorBills)
        .where(and(eq(vendorBills.id, input.billId), eq(vendorBills.tenantId, input.tenantId)));
      if (!bill) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill not found" });
      const events = await db.select().from(vendorBillEvents)
        .where(eq(vendorBillEvents.billId, bill.id))
        .orderBy(vendorBillEvents.createdAt);
      return { bill, events };
    }),

  /** Edit a bill BEFORE any payment has been recorded. */
  update: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      billId: z.string().uuid(),
      vendorName: z.string().max(160).optional(),
      vendorContact: z.record(z.string(), z.unknown()).optional(),
      billNumber: z.string().max(64).optional(),
      description: z.string().max(2000).optional(),
      amountCents: z.number().int().positive().optional(),
      issueDate: dateInput.optional(),
      dueDate: dateInput.nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const [bill] = await db.select().from(vendorBills)
        .where(and(eq(vendorBills.id, input.billId), eq(vendorBills.tenantId, input.tenantId)));
      if (!bill) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill not found" });
      if (bill.paidCents > 0 || bill.status === "paid" || bill.status === "cancelled") {
        throw new TRPCError({ code: "CONFLICT", message: `Cannot update a bill in status "${bill.status}" with payments recorded` });
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.vendorName !== undefined) patch.vendorName = input.vendorName;
      if (input.vendorContact !== undefined) patch.vendorContact = input.vendorContact;
      if (input.billNumber !== undefined) patch.billNumber = input.billNumber;
      if (input.description !== undefined) patch.description = input.description;
      if (input.amountCents !== undefined) patch.amountCents = input.amountCents;
      if (input.issueDate !== undefined) patch.issueDate = input.issueDate;
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
      const [updated] = await db.update(vendorBills).set(patch)
        .where(eq(vendorBills.id, bill.id)).returning();
      const { appendBillEvent } = await import("../services/vendorBills");
      await appendBillEvent(db, bill.id, "updated", String(ctx.user.id), { fields: Object.keys(patch).filter((k) => k !== "updatedAt") });
      return updated;
    }),

  /** Cancel an unpaid bill (honest: paid/partially-paid bills cannot be cancelled). */
  cancel: moneyProcedure
    .input(z.object({ tenantId: z.string(), billId: z.string().uuid(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const flipped = await db.update(vendorBills)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(
          eq(vendorBills.id, input.billId),
          eq(vendorBills.tenantId, input.tenantId),
          eq(vendorBills.paidCents, 0),
        ))
        .returning({ id: vendorBills.id, status: vendorBills.status });
      if (!flipped.length || flipped[0].status !== "cancelled") {
        const [bill] = await db.select().from(vendorBills)
          .where(and(eq(vendorBills.id, input.billId), eq(vendorBills.tenantId, input.tenantId)));
        if (!bill) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill not found" });
        if (bill.status === "cancelled") return { ok: true, billId: bill.id, status: "cancelled", duplicate: true };
        throw new TRPCError({ code: "CONFLICT", message: `Cannot cancel bill in status "${bill.status}" (paid_cents=${bill.paidCents})` });
      }
      const { appendBillEvent } = await import("../services/vendorBills");
      await appendBillEvent(db, input.billId, "cancelled", String(ctx.user.id), { reason: input.reason ?? null });
      return { ok: true, billId: input.billId, status: "cancelled" };
    }),

  /**
   * Record a full or partial payment with a REAL wallet debit. Replays of
   * the same paymentRef return the original outcome with duplicate:true and
   * no second debit. Insufficient balance → honest INSUFFICIENT_FUNDS error,
   * nothing moved.
   */
  recordPayment: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      billId: z.string().uuid(),
      amountCents: z.number().int().positive().optional(), // defaults to remaining balance
      paymentRef: z.string().max(128).optional(),
      approvalId: z.string().max(64).optional(), // approval-execution bypass (W31 Coder C contract)
      // === W32 pay-over-time === opt-in installment bill pay (3|6|12).
      payOverTime: z.object({
        installments: z.union([z.literal(3), z.literal(6), z.literal(12)]),
      }).optional(),
      // === END W32 pay-over-time ===
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      try {
        return await recordVendorBillPayment(db, {
          tenantId: input.tenantId,
          billId: input.billId,
          amountCents: input.amountCents ?? null,
          paymentRef: input.paymentRef ?? null,
          approvalId: input.approvalId ?? null,
          payOverTime: input.payOverTime ?? null,
          actor: String(ctx.user.id),
        });
      } catch (e) { rethrow(e); }
    }),

  // === W32 pay-over-time ===
  /** List the tenant's installment plans (read-only). */
  installmentPlans: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const { listInstallmentPlans } = await import("../services/payOverTime");
      return listInstallmentPlans(db, input.tenantId);
    }),

  /** Merchant's pay-over-time eligibility (score threshold + KYB). */
  payOverTimeEligibility: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const { checkPayOverTimeEligibility } = await import("../services/payOverTime");
      return checkPayOverTimeEligibility(db, input.tenantId);
    }),

  /**
   * Early-settle an active/defaulted plan: ONE mandate charge for the
   * remaining balance. Fee policy per escrow_config
   * (pay_over_time_prorate_early_fee; default full fee — documented in
   * services/payOverTime.ts).
   */
  settlePlanEarly: moneyProcedure
    .input(z.object({ tenantId: z.string(), planId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      try {
        const { settlePlanEarly } = await import("../services/payOverTime");
        return await settlePlanEarly(db, { tenantId: input.tenantId, planId: input.planId });
      } catch (e) { rethrow(e); }
    }),
  // === END W32 pay-over-time ===

  /**
   * Overdue sweep (cron/scheduled): flip unpaid bills past due_date to
   * 'overdue' — guarded UPDATE, safe to run repeatedly. Tenant-scoped.
   */
  markOverdue: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      return sweepOverdueVendorBills(db, input.tenantId, new Date());
    }),
});
