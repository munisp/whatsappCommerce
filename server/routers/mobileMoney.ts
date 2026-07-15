import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { mobileMoneyTransactions } from "../../drizzle/schema";
import { randomUUID } from "crypto";

export const mobileMoneyRouter = router({
  // ── Initiate MoMo Payment ────────────────────────────────────────────────
  initiate: publicProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string().optional(),
      provider: z.enum(["mtn_momo", "airtel_money", "mpesa", "orange_money", "wave"]),
      phoneNumber: z.string(),
      amount: z.string(),
      currency: z.string().default("NGN"),
      reference: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const externalRef = input.reference ?? `MOMO-${Date.now().toString(36).toUpperCase()}`;
      const now = new Date();
      const { description: _d, reference: _r, ...insertInput } = input;
      await db.insert(mobileMoneyTransactions).values({
        id, ...insertInput, externalRef, status: "initiated", createdAt: now, updatedAt: now,
      });
      // In production: call provider SDK (MTN MoMo API, Safaricom Daraja, etc.)
      return { id, externalRef, status: "initiated", message: `Payment of ${input.currency} ${input.amount} initiated via ${input.provider}` };
    }),

  // ── Webhook: Provider Callback ───────────────────────────────────────────
  handleCallback: publicProcedure
    .input(z.object({
      externalRef: z.string(),
      status: z.enum(["successful", "failed", "cancelled"]),
      providerResponse: z.record(z.string(), z.unknown()).optional(),
      callbackPayload: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const [txn] = await db.select().from(mobileMoneyTransactions).where(eq(mobileMoneyTransactions.externalRef, input.externalRef));
      if (!txn) return { ok: false, error: "Transaction not found" };
      await db.update(mobileMoneyTransactions).set({
        status: input.status,
        providerResponse: input.providerResponse ?? {},
        callbackPayload: input.callbackPayload ?? {},
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(mobileMoneyTransactions.id, txn.id));
      return { ok: true, orderId: txn.orderId };
    }),

  // ── List Transactions ────────────────────────────────────────────────────
  listTransactions: protectedProcedure
    .input(z.object({ tenantId: z.string(), provider: z.string().optional(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(mobileMoneyTransactions.tenantId, input.tenantId)];
      if (input.provider) conds.push(eq(mobileMoneyTransactions.provider, input.provider as "mtn_momo" | "airtel_money" | "mpesa" | "orange_money" | "wave"));
      if (input.status) conds.push(eq(mobileMoneyTransactions.status, input.status as "initiated" | "pending" | "successful" | "failed" | "cancelled" | "refunded"));
      return db.select().from(mobileMoneyTransactions).where(and(...conds)).orderBy(desc(mobileMoneyTransactions.createdAt)).limit(input.limit);
    }),

  // ── Stats ────────────────────────────────────────────────────────────────
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const txns = await db.select().from(mobileMoneyTransactions).where(eq(mobileMoneyTransactions.tenantId, input.tenantId));
      const byProvider: Record<string, number> = {};
      let totalVolume = 0;
      for (const t of txns) {
        if (t.status === "successful") {
          byProvider[t.provider] = (byProvider[t.provider] ?? 0) + 1;
          totalVolume += parseFloat(t.amount);
        }
      }
      return {
        total: txns.length,
        successful: txns.filter(t => t.status === "successful").length,
        failed: txns.filter(t => t.status === "failed").length,
        pending: txns.filter(t => t.status === "initiated" || t.status === "pending").length,
        totalVolume: totalVolume.toFixed(2),
        byProvider,
      };
    }),
});
