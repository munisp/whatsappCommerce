/**
 * W31 (Coder D): AR invoices router — payment links + reminders.
 *
 * SEPARATE from the existing commission-invoice router (routers/invoice.ts),
 * which is untouched and keeps working as before.
 *
 * Tenant guards: create/send/recordPayment/cancel are moneyProcedure
 * (owner|operator membership; admin bypass), list/get are analystProcedure
 * (read-only). getByLinkRef is the PUBLIC payment-page surface following the
 * tracking.ts getByToken exemplar: keyed by an unguessable link reference,
 * returns ONLY the invoice's own fields (no tenant data beyond the invoice),
 * and answers honestly expired for cancelled invoices.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { analystProcedure, moneyProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { arInvoices } from "../../drizzle/schema";
import {
  ArInvoiceError,
  agingBucket,
  cancelArInvoice,
  createArInvoice,
  recordVerifiedArPayment,
  sendArInvoice,
} from "../services/arInvoices";

function mapErr(err: unknown): never {
  if (err instanceof ArInvoiceError) {
    const code =
      err.code === "not-found" ? "NOT_FOUND"
      : err.code === "forbidden" ? "FORBIDDEN"
      : err.code === "invalid-amount" ? "BAD_REQUEST"
      : ["already-paid", "cancelled", "nothing-outstanding", "race"].includes(err.code) ? "CONFLICT"
      : ["provider-not-configured", "provider-init-failed"].includes(err.code) ? "PRECONDITION_FAILED"
      : "INTERNAL_SERVER_ERROR";
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

export const arInvoicesRouter = router({
  /** Create a draft AR invoice (tenant-scoped invoice_no sequence). */
  create: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      customerName: z.string().max(200).optional(),
      customerPhone: z.string().max(20).optional(),
      customerEmail: z.string().email().max(320).optional(),
      description: z.string().max(2000).optional(),
      amountCents: z.number().int().positive(),
      currency: z.string().length(3).default("NGN"),
      dueDate: z.string().datetime().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      try {
        return await createArInvoice(db, {
          tenantId: input.tenantId,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          customerEmail: input.customerEmail ?? null,
          description: input.description ?? null,
          amountCents: input.amountCents,
          currency: input.currency,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
        });
      } catch (err) { mapErr(err); }
    }),

  /**
   * Send: mint a PSP payment link via the provider fallback chain (sim:
   * metaMock paystack /transaction/initialize), flip draft → sent, and
   * WhatsApp the customer the link. Re-send reuses the open link.
   */
  send: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      invoiceId: z.string().uuid(),
      /** Optional partial link amount (≤ outstanding) — honest partial payments. */
      amountCents: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      try {
        return await sendArInvoice(db, input.tenantId, input.invoiceId, input.amountCents ?? null);
      } catch (err) { mapErr(err); }
    }),

  /** List with aging buckets (read-only). */
  list: analystProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["draft", "sent", "viewed", "partially_paid", "paid", "overdue", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const conditions = [eq(arInvoices.tenantId, input.tenantId)];
      if (input.status) conditions.push(eq(arInvoices.status, input.status));
      const rows = await db.select().from(arInvoices)
        .where(and(...conditions))
        .orderBy(desc(arInvoices.createdAt))
        .limit(input.limit);
      const now = new Date();
      return rows.map((r: any) => ({
        ...r,
        outstandingCents: r.amountCents - r.paidCents,
        aging: agingBucket(r.dueDate, r.status, now),
      }));
    }),

  /** Get one invoice with payments + aging (read-only). */
  get: analystProcedure
    .input(z.object({ tenantId: z.string(), invoiceId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const [inv] = await db.select().from(arInvoices)
        .where(and(eq(arInvoices.id, input.invoiceId), eq(arInvoices.tenantId, input.tenantId)))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "AR invoice not found" });
      const { arInvoicePayments } = await import("../../drizzle/schema");
      const payments = await db.select().from(arInvoicePayments)
        .where(eq(arInvoicePayments.invoiceId, inv.id));
      return {
        ...inv,
        outstandingCents: inv.amountCents - inv.paidCents,
        aging: agingBucket(inv.dueDate, inv.status),
        payments,
      };
    }),

  /**
   * Record a payment for the invoice's link reference — ONLY after verified
   * provider status (local completed record from the verified webhook, or a
   * live provider probe via hasVerifiedPayment). Unverified → honest error,
   * nothing is marked paid. Exactly-once via unique psp_reference.
   */
  recordPayment: moneyProcedure
    .input(z.object({ tenantId: z.string(), invoiceId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      const [inv] = await db.select().from(arInvoices)
        .where(and(eq(arInvoices.id, input.invoiceId), eq(arInvoices.tenantId, input.tenantId)))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "AR invoice not found" });
      if (!inv.paymentLinkRef) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invoice has no payment link — send it first" });
      }
      const result = await recordVerifiedArPayment(db, { reference: inv.paymentLinkRef, tenantId: input.tenantId });
      if (!result.recorded && result.reason === "forbidden") {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only access your own tenant's data" });
      }
      if (!result.recorded && result.reason?.startsWith("unverified")) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Payment not verified by the provider (${result.reason}) — the invoice is NOT marked paid`,
        });
      }
      return result;
    }),

  /** Cancel an unpaid invoice; the public link answers honestly expired. */
  cancel: moneyProcedure
    .input(z.object({ tenantId: z.string(), invoiceId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      try {
        return await cancelArInvoice(db, input.tenantId, input.invoiceId);
      } catch (err) { mapErr(err); }
    }),

  /**
   * PUBLIC payment-page view by link reference (tracking.ts exemplar: bearer
   * capability, PII-minimal — no tenant id, no full customer PII beyond the
   * first name on the invoice). Cancelled → honest PRECONDITION_FAILED
   * ("link expired", the 410 equivalent for the public page); viewing marks
   * viewed_at once.
   */
  getByLinkRef: publicProcedure
    .input(z.object({ ref: z.string().min(8).max(64) }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const [inv] = await db.select().from(arInvoices)
        .where(eq(arInvoices.paymentLinkRef, input.ref)).limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Payment link not found" });
      if (inv.status === "cancelled") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This payment link has expired (invoice cancelled)" });
      }
      // Mark viewed (sent → viewed, once) — best-effort, never fails the view.
      if (inv.status === "sent") {
        await db.update(arInvoices)
          .set({ status: "viewed", viewedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(arInvoices.id, inv.id), eq(arInvoices.status, "sent")))
          .catch(() => {});
      }
      return {
        invoiceNo: inv.invoiceNo,
        customerFirstName: inv.customerName?.trim().split(/\s+/)[0] ?? null,
        description: inv.description,
        amountCents: inv.amountCents,
        paidCents: inv.paidCents,
        outstandingCents: inv.amountCents - inv.paidCents,
        currency: inv.currency,
        dueDate: inv.dueDate,
        status: inv.status,
        // Only expose the hosted payment URL while the invoice is payable.
        paymentUrl: ["sent", "viewed", "partially_paid", "overdue"].includes(inv.status)
          ? inv.paymentUrl ?? null
          : null,
      };
    }),
});
