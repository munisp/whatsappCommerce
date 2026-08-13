/**
 * W14 F4 — lender-facing credit facility servicing router.
 *
 * PLATFORM-ADMIN ONLY: every procedure is an adminProcedure. Facilities are
 * lender warehouse lines and the tape/covenant outputs expose the whole
 * trade-credit book across tenants, so no tenant-scoped role may call them.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  assignAccountToFacility,
  checkFacilityCovenants,
  createFacility,
  generateLoanBookTape,
  listFacilities,
  tapeEmailPreview,
  CreditAccountNotFoundError,
  FacilityNotFoundError,
  FacilityRefExistsError,
} from "../services/creditFacilities";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

function rethrowKnown(err: unknown): never {
  if (err instanceof FacilityRefExistsError) {
    throw new TRPCError({ code: "CONFLICT", message: err.message });
  }
  if (err instanceof FacilityNotFoundError || err instanceof CreditAccountNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}

export const creditFacilitiesRouter = router({
  /** Create a lender facility (warehouse line). */
  createFacility: adminProcedure
    .input(
      z.object({
        lenderName: z.string().min(1).max(255),
        facilityRef: z.string().min(1).max(64),
        commitmentCents: z.number().int().min(0),
        currency: z.string().length(3).optional(),
        advanceRateBps: z.number().int().min(0).max(10_000).optional(),
        covenants: z.record(z.string(), z.unknown()).nullish(),
        status: z.enum(["active", "suspended", "closed"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await requireDb();
      try {
        return await createFacility(db, {
          lenderName: input.lenderName,
          facilityRef: input.facilityRef,
          commitmentCents: input.commitmentCents,
          currency: input.currency,
          advanceRateBps: input.advanceRateBps,
          covenants: (input.covenants ?? null) as Record<string, unknown> | null,
          status: input.status,
        });
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** List all facilities with computed utilization and advance headroom. */
  listFacilities: adminProcedure.query(async () => {
    const db = await requireDb();
    return listFacilities(db);
  }),

  /** Assign a credit account to a facility (sets credit_accounts.facility_id). */
  assignAccount: adminProcedure
    .input(z.object({ accountId: z.string().min(1), facilityId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      try {
        return await assignAccountToFacility(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /**
   * Loan-book tape export. format='json' returns rows+summary (csv omitted);
   * format='csv' returns a downloadable CSV document.
   */
  generateTape: adminProcedure
    .input(
      z.object({
        facilityId: z.string().min(1).optional(),
        asOf: z.coerce.date().optional(),
        format: z.enum(["json", "csv"]).default("json"),
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      try {
        const tape = await generateLoanBookTape(db, { facilityId: input.facilityId, asOf: input.asOf });
        if (input.format === "csv") {
          return {
            format: "csv" as const,
            filename: `loan-book-tape-${tape.asOf.slice(0, 10)}.csv`,
            contentType: "text/csv",
            content: tape.csv,
            summary: tape.summary,
          };
        }
        return { format: "json" as const, asOf: tape.asOf, facilityRef: tape.facilityRef, rows: tape.rows, summary: tape.summary };
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Covenant compliance check for one facility. */
  covenantCheck: adminProcedure
    .input(z.object({ facilityId: z.string().min(1), asOf: z.coerce.date().optional() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      try {
        return await checkFacilityCovenants(db, input.facilityId, { asOf: input.asOf });
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Plaintext monthly tape summary lenders receive (text only, no sending). */
  tapeEmailPreview: adminProcedure
    .input(z.object({ facilityId: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      try {
        return { facilityId: input.facilityId, text: await tapeEmailPreview(db, input.facilityId) };
      } catch (err) {
        rethrowKnown(err);
      }
    }),
});
