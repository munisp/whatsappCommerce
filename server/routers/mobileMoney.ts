import { z } from "zod";
import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { mobileMoneyTransactions } from "../../drizzle/schema";
import { randomUUID } from "crypto";

/**
 * W30 (V3#14): the MoMo façade has NO real provider integration — it only
 * records rows. In production, without explicit provider configuration
 * (MOBILE_MONEY_LIVE=true once a real SDK is wired), the rail FAILS CLOSED:
 * initiate returns an honest "unavailable in this deployment" instead of
 * fabricating a payment initiation. Non-production keeps the simulated rail
 * clearly labelled as simulated (stats included).
 */
export function mobileMoneyLive(): boolean {
  return (process.env.MOBILE_MONEY_LIVE ?? "").trim().toLowerCase() === "true";
}

function mobileMoneySimulated(): boolean {
  return !mobileMoneyLive();
}

const SIM_LABEL = "SIMULATED — no real provider is configured; no money moved";

export const mobileMoneyRouter = router({
  // ── Initiate MoMo Payment ────────────────────────────────────────────────
  initiate: protectedProcedure
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
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      // W30: fail closed in production when no real provider is configured.
      if (mobileMoneySimulated() && (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging")) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Mobile money is unavailable in this deployment — no provider is configured (MOBILE_MONEY_LIVE). No payment was initiated.",
        });
      }
      const simulated = mobileMoneySimulated();
      const db = (await getDb())!;
      const id = randomUUID();
      const externalRef = input.reference ?? `MOMO-${Date.now().toString(36).toUpperCase()}`;
      const now = new Date();
      const { description: _d, reference: _r, ...insertInput } = input;
      await db.insert(mobileMoneyTransactions).values({
        id, ...insertInput, externalRef, status: "initiated",
        providerResponse: simulated ? { simulated: true } : {},
        createdAt: now, updatedAt: now,
      });
      // When MOBILE_MONEY_LIVE=true a real provider SDK call goes here.
      return {
        id, externalRef, status: "initiated",
        simulated,
        message: simulated
          ? `${SIM_LABEL}. Recorded initiation of ${input.currency} ${input.amount} via ${input.provider}.`
          : `Payment of ${input.currency} ${input.amount} initiated via ${input.provider}`,
      };
    }),

  // ── Webhook: Provider Callback ───────────────────────────────────────────
  // Public (providers call it), but authenticated via HMAC: the provider signs
  // `${externalRef}:${status}` with MOBILE_MONEY_WEBHOOK_SECRET and sends the
  // hex digest in the X-Callback-Signature header (MTN/Airtel style). Fails
  // CLOSED in production when the secret is unset.
  handleCallback: publicProcedure
    .input(z.object({
      externalRef: z.string(),
      status: z.enum(["successful", "failed", "cancelled"]),
      providerResponse: z.record(z.string(), z.unknown()).optional(),
      callbackPayload: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const secret = process.env.MOBILE_MONEY_WEBHOOK_SECRET ?? "";
      if (!secret) {
        if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
          console.error("[mobileMoney] MOBILE_MONEY_WEBHOOK_SECRET is not configured — refusing callback (fail closed)");
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "webhook-secret-not-configured" });
        }
        console.warn("[mobileMoney] MOBILE_MONEY_WEBHOOK_SECRET unset — accepting UNSIGNED callback (non-production mode)");
      } else {
        const sig = ((ctx.req.headers["x-callback-signature"] as string) ?? "").replace(/^sha256=/, "");
        const expected = crypto.createHmac("sha256", secret)
          .update(`${input.externalRef}:${input.status}`)
          .digest("hex");
        const a = Buffer.from(sig, "utf8");
        const b = Buffer.from(expected, "utf8");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          console.warn(`[mobileMoney] invalid callback signature for externalRef=${input.externalRef} — rejected`);
          throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid-signature" });
        }
      }

      const [txn] = await db.select().from(mobileMoneyTransactions).where(eq(mobileMoneyTransactions.externalRef, input.externalRef));
      if (!txn) return { ok: false, error: "Transaction not found" };
      // Idempotency / final-state guard: successful and refunded are terminal,
      // and a duplicate delivery of the same status is a no-op.
      if (txn.status === "successful" || txn.status === "refunded" || txn.status === input.status) {
        return { ok: true, skipped: true, status: txn.status, orderId: txn.orderId };
      }
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
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(mobileMoneyTransactions.tenantId, input.tenantId)];
      if (input.provider) conds.push(eq(mobileMoneyTransactions.provider, input.provider as "mtn_momo" | "airtel_money" | "mpesa" | "orange_money" | "wave"));
      if (input.status) conds.push(eq(mobileMoneyTransactions.status, input.status as "initiated" | "pending" | "successful" | "failed" | "cancelled" | "refunded"));
      return db.select().from(mobileMoneyTransactions).where(and(...conds)).orderBy(desc(mobileMoneyTransactions.createdAt)).limit(input.limit);
    }),

  // ── Stats ────────────────────────────────────────────────────────────────
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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
      const simulated = mobileMoneySimulated();
      return {
        total: txns.length,
        successful: txns.filter(t => t.status === "successful").length,
        failed: txns.filter(t => t.status === "failed").length,
        pending: txns.filter(t => t.status === "initiated" || t.status === "pending").length,
        // W30: never present simulated rows as real processed volume.
        totalVolume: simulated ? "0.00" : totalVolume.toFixed(2),
        simulated,
        volumeNote: simulated
          ? `${SIM_LABEL} — volume is reported as 0 because no real rail processed these rows.`
          : undefined,
        byProvider: simulated ? {} : byProvider,
      };
    }),
});
