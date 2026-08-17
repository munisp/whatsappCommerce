/**
 * W18 — manufacturer credit programs router (manufacturer-side).
 *
 * TENANT ISOLATION: every procedure is a protectedProcedure gated by
 * assertTenantAccess(ctx.user, input.tenantId) — the manufacturer tenant
 * administering its own programs. Reads/mutations are additionally scoped
 * to (program_id, tenant_id) inside the service, so a cross-tenant program
 * id resolves to NOT_FOUND even if the input check were bypassed.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  assignAccountToProgram,
  checkDrawAllowed,
  createProgram,
  effectiveScoringConfig,
  generateProgramTape,
  getProgramBook,
  getProgramForTenant,
  listPrograms,
  setProgramStatus,
  suggestLimitForProgramTx,
  unassignAccountFromProgram,
  updateProgram,
  ProgramAccountNotFoundError,
  ProgramNameExistsError,
  ProgramNotFoundError,
} from "../services/manufacturerPrograms";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

function rethrowKnown(err: unknown): never {
  if (err instanceof ProgramNameExistsError) {
    throw new TRPCError({ code: "CONFLICT", message: err.message });
  }
  if (err instanceof ProgramNotFoundError || err instanceof ProgramAccountNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}

const scoringWeightsSchema = z
  .object({
    onTime: z.number().min(0).max(1).optional(),
    volume: z.number().min(0).max(1).optional(),
    tenure: z.number().min(0).max(1).optional(),
  })
  .nullish();

export const manufacturerProgramsRouter = router({
  /** Create a program (starts as draft unless status given). */
  create: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        name: z.string().min(1).max(255),
        maxExposureCents: z.number().int().min(0),
        programCapCents: z.number().int().min(0),
        concentrationCapBps: z.number().int().min(0).max(10_000).optional(),
        allowedTenorDays: z.array(z.number().int().min(1)).optional(),
        feeBps: z.number().int().min(0).max(10_000).optional(),
        scoringWeights: scoringWeightsSchema,
        status: z.enum(["draft", "active", "suspended"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await createProgram(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Update program caps/tenors/fees/scoring overrides. */
  update: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        programId: z.string().min(1),
        name: z.string().min(1).max(255).optional(),
        maxExposureCents: z.number().int().min(0).optional(),
        programCapCents: z.number().int().min(0).optional(),
        concentrationCapBps: z.number().int().min(0).max(10_000).optional(),
        allowedTenorDays: z.array(z.number().int().min(1)).optional(),
        feeBps: z.number().int().min(0).max(10_000).optional(),
        scoringWeights: scoringWeightsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const { tenantId, programId, ...patch } = input;
      try {
        return await updateProgram(db, { tenantId, programId, ...patch });
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Lifecycle: draft → active ⇄ suspended. */
  setStatus: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        programId: z.string().min(1),
        status: z.enum(["draft", "active", "suspended"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await setProgramStatus(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Fetch one program (tenant-owned) with its effective scoring config. */
  get: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), programId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const program = await getProgramForTenant(db, input.programId, input.tenantId);
      if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "Program not found" });
      return { ...program, effectiveScoring: effectiveScoringConfig(program) };
    }),

  /** List the manufacturer tenant's programs. */
  list: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return listPrograms(db, input.tenantId);
    }),

  /** Link a trade-credit account (supplier = manufacturer tenant) to the program. */
  assignAccount: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), programId: z.string().min(1), accountId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await assignAccountToProgram(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Remove an account from the program book. */
  unassignAccount: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), programId: z.string().min(1), accountId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await unassignAccountFromProgram(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Program book: assigned accounts, utilization vs caps, concentration ranking. */
  programBook: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), programId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await getProgramBook(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Gate a buyer draw against the program caps. */
  checkDrawAllowed: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        programId: z.string().min(1),
        buyerTenantId: z.string().min(1),
        amountCents: z.number().int().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await checkDrawAllowed(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Program-capped limit suggestion for a buyer under this program. */
  suggestLimitForProgram: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), programId: z.string().min(1), buyerTenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        return await suggestLimitForProgramTx(db, input);
      } catch (err) {
        rethrowKnown(err);
      }
    }),

  /** Program-scoped loan tape; format='csv' returns a downloadable document. */
  programTape: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        programId: z.string().min(1),
        asOf: z.coerce.date().optional(),
        format: z.enum(["json", "csv"]).default("json"),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      try {
        const tape = await generateProgramTape(db, input);
        if (input.format === "csv") {
          return {
            format: "csv" as const,
            filename: `program-tape-${tape.asOf.slice(0, 10)}.csv`,
            contentType: "text/csv",
            content: tape.csv,
            summary: tape.summary,
          };
        }
        return {
          format: "json" as const,
          asOf: tape.asOf,
          programId: tape.programId,
          programName: tape.programName,
          rows: tape.rows,
          summary: tape.summary,
        };
      } catch (err) {
        rethrowKnown(err);
      }
    }),
});
