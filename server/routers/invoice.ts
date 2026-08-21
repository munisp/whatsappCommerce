/**
 * Invoice generation — subscription and profit-sharing billing models
 */
import { z } from "zod";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { invoices, orders, tenants, paymentIntents } from "../../drizzle/schema";
import { ENV } from "../_core/env";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Confirm a Paystack-initiated invoice payment (called from the payment-
 * confirmation hook chain, mirroring escrow.ts's creditWalletTopUp). Claims
 * the payment intent atomically via a conditional UPDATE stamping
 * metadata.creditedAt, so webhook replays can never double-process — the
 * invoice is only ever marked paid once.
 */
export async function markInvoicePaidFromPaymentIntent(
  db: Db,
  paymentIntentId: string,
): Promise<{ paid: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      UPDATE payment_intents
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{creditedAt}', to_jsonb(now()::text), true),
          updated_at = now()
      WHERE id = ${paymentIntentId}
        AND status = 'completed'
        AND metadata->>'type' = 'invoice_payment'
        AND metadata->>'invoiceId' IS NOT NULL
        AND metadata->>'creditedAt' IS NULL
      RETURNING metadata
    `);
    const row = (claimed as unknown as Record<string, unknown>[])[0];
    if (!row) return { paid: false, reason: "Not a completed, uncredited invoice payment" };
    const invoiceId = String((row.metadata as Record<string, unknown>).invoiceId);
    await tx.update(invoices)
      .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), sql`${invoices.status} <> 'paid'`));
    return { paid: true };
  });
}

export const invoiceRouter = router({
  /** Generate a monthly invoice for a tenant */
  generate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      type: z.enum(["subscription", "profit_share", "one_time"]),
      periodStart: z.string().datetime().optional(),
      periodEnd: z.string().datetime().optional(),
      subscriptionFee: z.number().optional(),
      commissionRate: z.number().min(0).max(1).optional(), // e.g. 0.05 = 5%
      currency: z.string().default("NGN"),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const periodStart = input.periodStart ? new Date(input.periodStart) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const periodEnd = input.periodEnd ? new Date(input.periodEnd) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

      let subtotal = 0;
      let commissionAmount = 0;
      let subscriptionFee = input.subscriptionFee ?? 0;
      const lineItems: Array<{ description: string; amount: number; currency: string }> = [];

      if (input.type === "profit_share") {
        // Sum completed orders in period
        const result = await db.execute(sql`
          SELECT COALESCE(SUM(CAST("totalAmount" AS NUMERIC)), 0) AS revenue
          FROM orders
          WHERE "tenantId" = ${input.tenantId}
            AND "paymentStatus" = 'completed'
            AND "createdAt" >= ${periodStart}
            AND "createdAt" <= ${periodEnd}
        `);
        const revenue = Number((result as any[])[0]?.revenue ?? 0);
        // Integer minor units: convert to cents first, then apply the rate
        // and round exactly once — no float commission drift (fee must be a
        // clean cent amount for the invoice total to reconcile).
        const revenueMinor = Math.round(revenue * 100);
        const commissionMinor = Math.round(revenueMinor * (input.commissionRate ?? 0.05));
        subtotal = revenueMinor / 100;
        commissionAmount = commissionMinor / 100;
        lineItems.push({ description: `Revenue (${periodStart.toLocaleDateString()} – ${periodEnd.toLocaleDateString()})`, amount: revenue, currency: input.currency });
        lineItems.push({ description: `Platform commission (${((input.commissionRate ?? 0.05) * 100).toFixed(1)}%)`, amount: commissionAmount, currency: input.currency });
      } else if (input.type === "subscription") {
        subscriptionFee = input.subscriptionFee ?? 0;
        lineItems.push({ description: `Monthly subscription fee`, amount: subscriptionFee, currency: input.currency });
      } else {
        lineItems.push({ description: "One-time charge", amount: input.subscriptionFee ?? 0, currency: input.currency });
        subscriptionFee = input.subscriptionFee ?? 0;
      }

      const totalAmount = input.type === "profit_share" ? commissionAmount : subscriptionFee;
      const invoiceNumber = `INV-${input.tenantId.slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
      const dueDate = new Date(Date.now() + 14 * 86400000); // 14 days

      const [invoice] = await db.insert(invoices).values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        invoiceNumber,
        type: input.type,
        status: "draft",
        periodStart,
        periodEnd,
        subtotal: subtotal.toFixed(2),
        commissionRate: input.commissionRate?.toFixed(4),
        commissionAmount: commissionAmount.toFixed(2),
        subscriptionFee: subscriptionFee.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        currency: input.currency,
        lineItems,
        dueDate,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      return invoice;
    }),

  /** List invoices for a tenant */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["draft", "sent", "paid", "overdue", "cancelled"]).optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const conditions = [eq(invoices.tenantId, input.tenantId)];
      if (input.status) conditions.push(eq(invoices.status, input.status));
      return db.select().from(invoices)
        .where(and(...conditions))
        .orderBy(sql`${invoices.createdAt} DESC`)
        .limit(input.limit);
    }),

  /**
   * Generate a real Paystack checkout link for an invoice, charged to the
   * PLATFORM's own Paystack account (ENV.paystackSecretKey) — this is the
   * platform collecting from the tenant, never the tenant's own gateway keys.
   * Mirrors wallet.topUp's pattern exactly: a payment_intents row tagged
   * metadata.type = "invoice_payment" is picked up by the same webhook →
   * confirmProviderPayment path, which calls markInvoicePaidFromPaymentIntent.
   */
  initiatePaystackPayment: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      assertTenantAccess(ctx.user, inv.tenantId);
      if (inv.status === "paid") {
        throw new TRPCError({ code: "CONFLICT", message: "This invoice is already paid" });
      }
      if (!ENV.paystackSecretKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No platform payment provider configured (set PAYSTACK_SECRET_KEY). Invoice payment cannot be initiated.",
        });
      }
      const amount = parseFloat(inv.totalAmount);
      if (!(amount > 0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invoice has no amount due" });
      }

      const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, inv.tenantId)).limit(1);
      const paymentIntentId = crypto.randomUUID();
      const ref = `INV-PAY-${Date.now()}-${inv.tenantId.slice(0, 6).toUpperCase()}`;

      // payment_intents.orderId / customerId are NOT NULL and have no invoice
      // concept — scope by invoice/tenant id, same convention as wallet top-up.
      await db.insert(paymentIntents).values({
        id: paymentIntentId,
        tenantId: inv.tenantId,
        orderId: inv.id,
        customerId: inv.tenantId,
        amount: amount.toFixed(2),
        currency: inv.currency,
        provider: "paystack",
        status: "pending",
        providerPaymentId: ref,
        idempotencyKey: `invoice-payment:${ref}`,
        metadata: { type: "invoice_payment", invoiceId: inv.id, invoiceNumber: inv.invoiceNumber },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: { Authorization: `Bearer ${ENV.paystackSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `billing-${inv.tenantId.replace(/[^a-zA-Z0-9]/g, "")}@wa-app.newfire.app`,
          amount: Math.round(amount * 100),
          currency: inv.currency,
          reference: ref,
          metadata: { payment_intent_id: paymentIntentId, tenant_id: inv.tenantId, type: "invoice_payment", invoice_id: inv.id },
          // The webhook (server-to-server) is what actually marks the invoice
          // paid — this is only the browser redirect after checkout, so send
          // the tenant back to their invoices page in the portal.
          callback_url: `${ENV.appUrl}/tenant-portal/invoices`,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch((err: unknown) => {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Paystack request failed: ${(err as Error)?.message ?? "network error"}` });
      });
      if (!psRes.ok) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Paystack initialization failed: ${await psRes.text()}` });
      }
      const psData = await psRes.json() as { status: boolean; data?: { authorization_url: string } };
      if (!psData.status || !psData.data?.authorization_url) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Paystack returned status=false" });
      }

      return {
        paymentUrl: psData.data.authorization_url,
        reference: ref,
        amount,
        currency: inv.currency,
        tenantName: tenant?.name ?? null,
      };
    }),

  /** Mark invoice as sent */
  send: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      assertTenantAccess(ctx.user, inv.tenantId);
      await db.update(invoices).set({
        status: "sent",
        sentAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(invoices.id, input.invoiceId));
      return { ok: true };
    }),

  /** Mark invoice as paid */
  markPaid: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      assertTenantAccess(ctx.user, inv.tenantId);
      await db.update(invoices).set({
        status: "paid",
        paidAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(invoices.id, input.invoiceId));
      return { ok: true };
    }),

  /** Get invoice details */
  get: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      assertTenantAccess(ctx.user, invoice.tenantId);
      return invoice;
    }),

  /** Summary stats */
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const result = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
          COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
          COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
          COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_count,
          COALESCE(SUM(CAST("totalAmount" AS NUMERIC)) FILTER (WHERE status = 'paid'), 0) AS total_collected,
          COALESCE(SUM(CAST("totalAmount" AS NUMERIC)) FILTER (WHERE status IN ('sent','overdue')), 0) AS total_outstanding
        FROM invoices WHERE "tenantId" = ${input.tenantId}
      `);
      return (result as any[])[0] ?? {};
    }),
});

