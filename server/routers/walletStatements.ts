// === W58 statements ===
/**
 * W58 statements — merchant wallet statement router (tenant-scoped).
 *
 *   generateStatement    moneyProcedure  — build (idempotently rebuild) the
 *                        statement PDF for a month or explicit period.
 *   listStatements       analystProcedure — manifest index (generated files).
 *   getStatementDownload analystProcedure — authorized download: mints a
 *                        capability token bound to the exact uc-docs key
 *                        (same media-security pattern as the W46 uc-docs
 *                        route — private prefix, no public URLs).
 *
 * Money-adjacent reads follow the existing guard style: assertTenantAccess
 * inside the role procedures (tenantRoleProcedure) — the W12/A2-02 authz
 * ratchet requires an explicit guard call, so each procedure calls
 * assertTenantAccess(ctx.user, input.tenantId) too.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { analystProcedure, assertTenantAccess, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function rethrow(err: any): never {
  if (err instanceof TRPCError) throw err;
  const code = ["NOT_FOUND", "CONFLICT", "FORBIDDEN"].includes(err?.code) ? err.code : "BAD_REQUEST";
  throw new TRPCError({ code, message: err?.message ?? String(err) });
}

/** "YYYY-MM" → [first day, first day of next month). */
function monthPeriod(month: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "month must be YYYY-MM" });
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) throw new TRPCError({ code: "BAD_REQUEST", message: "month must be YYYY-MM" });
  return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 1)) };
}

export const walletStatementsRouter = router({
  generateStatement: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      month: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const period = input.month
        ? monthPeriod(input.month)
        : input.from && input.to
          ? { from: input.from, to: input.to }
          : (() => { throw new TRPCError({ code: "BAD_REQUEST", message: "pass month (YYYY-MM) or from+to" }); })();
      try {
        const { generateWalletStatement } = await import("../services/walletStatements");
        return await generateWalletStatement(db, { tenantId: input.tenantId, ...period });
      } catch (e) { rethrow(e); }
    }),

  listStatements: analystProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { listWalletStatements } = await import("../services/walletStatements");
      return listWalletStatements(input.tenantId);
    }),

  /** Authorized download: capability-token URL for the exact PDF key. */
  getStatementDownload: analystProcedure
    .input(z.object({ tenantId: z.string(), statementId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { getWalletStatementRecord } = await import("../services/walletStatements");
      const record = getWalletStatementRecord(input.tenantId, input.statementId);
      if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "statement not found" });
      const { mintCapabilityToken } = await import("../services/capabilityTokens");
      const cap = mintCapabilityToken({ type: "storage_cap", resource: `uc-docs/${record.pdfPath}`, tenantId: input.tenantId }, 3600);
      return {
        url: `/api/uc-docs/${record.pdfPath}?cap=${encodeURIComponent(cap)}`,
        filename: record.pdfPath.split("/").pop()!,
        periodStart: record.periodStart,
        periodEnd: record.periodEnd,
      };
    }),
});
// === END W58 statements ===
