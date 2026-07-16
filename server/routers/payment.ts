import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";
import { ENV } from "../_core/env";

export const paymentRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      return db.getPaymentIntents(input.tenantId, input.status, input.limit, input.offset);
    }),

  /** Query TigerBeetle ledger balance for a tenant account */
  getLedgerBalance: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .query(async ({ input }) => {
      try {
        const res = await fetch(`${ENV.ledgerBridgeUrl}/balance/${encodeURIComponent(input.accountId)}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error(`Ledger bridge error: ${res.status}`);
        return (await res.json()) as { accountId: string; credits: number; debits: number; balance: number };
      } catch (err: any) {
        return { accountId: input.accountId, credits: 0, debits: 0, balance: 0, error: err.message };
      }
    }),

  /** Reconcile TigerBeetle balance vs DB payment_intents sum */
  reconcileLedger: protectedProcedure
    .input(z.object({ tenantId: z.string(), accountId: z.string() }))
    .query(async ({ input }) => {
      const dbIntents = await db.getPaymentIntents(input.tenantId, "completed", 1000, 0);
      const dbSum = (dbIntents as any[]).reduce((s: number, p: any) => s + parseFloat(p.amount ?? "0"), 0);
      let ledgerBalance = 0;
      try {
        const res = await fetch(`${ENV.ledgerBridgeUrl}/balance/${encodeURIComponent(input.accountId)}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          ledgerBalance = data.balance ?? 0;
        }
      } catch { /* ledger unavailable */ }
      const drift = Math.abs(dbSum - ledgerBalance);
      return { dbSum, ledgerBalance, drift, inSync: drift < 0.01 };
    }),
});
