// === W59 banking-pos ===
/**
 * W59 banking-pos (Feature 3) — POS payments router (tenant-scoped,
 * moneyProcedure + assertTenantAccess).
 *
 *   registerTerminal / listTerminals / setTerminalStatus — registry CRUD
 *   createSession   — payment session + USSD short code + QR payload
 *   sessionStatus   — poll one session by reference
 *   listSessions    — recent sessions
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { assertTenantAccess, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { posPaymentSessions } from "../../drizzle/schema";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

export const posPaymentsRouter = router({
  registerTerminal: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      provider: z.enum(["paystack", "flutterwave", "softpos"]),
      terminalRef: z.string().min(1).max(64),
      label: z.string().max(64).optional(),
      storeLocation: z.string().max(255).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { registerTerminal } = await import("../services/posPayments");
      return registerTerminal(db, input);
    }),

  listTerminals: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { listTerminals } = await import("../services/posPayments");
      return listTerminals(db, input.tenantId);
    }),

  setTerminalStatus: moneyProcedure
    .input(z.object({ tenantId: z.string(), terminalId: z.string().uuid(), status: z.enum(["active", "disabled"]) }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { setTerminalStatus } = await import("../services/posPayments");
      return setTerminalStatus(db, input.tenantId, input.terminalId, input.status);
    }),

  createSession: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      amountCents: z.number().int().positive(),
      channel: z.enum(["physical", "softpos", "ussd_ref"]),
      orderId: z.string().optional(),
      terminalId: z.string().uuid().optional(),
      ttlMinutes: z.number().int().min(1).max(120).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { createSession } = await import("../services/posPayments");
      return createSession(db, input);
    }),

  sessionStatus: moneyProcedure
    .input(z.object({ tenantId: z.string(), reference: z.string().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const [session] = await db.select().from(posPaymentSessions)
        .where(eq(posPaymentSessions.reference, input.reference));
      if (!session || session.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "POS session not found" });
      }
      return session;
    }),

  listSessions: moneyProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { listSessions } = await import("../services/posPayments");
      return listSessions(db, input.tenantId, input.limit);
    }),
});
