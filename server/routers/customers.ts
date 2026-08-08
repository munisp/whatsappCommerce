/**
 * Customers router — tenant-scoped customer lifecycle.
 *
 * customers.create is the canonical way for integrations / order flows to
 * register a WhatsApp customer: phone is normalized (digits-only, matching
 * waSender.normalizeWaPhone) and the (tenantId, whatsappPhone) pair is
 * unique — an existing row is returned as-is (upsert semantics) instead of
 * throwing on the unique index, so concurrent order/integration flows can
 * never race-create duplicates.
 */
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { assertTenantAccess, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { customers } from "../../drizzle/schema";
import { normalizeWaPhone } from "../services/waSender";

export const customersRouter = router({
  /**
   * Create (or return) a customer by WhatsApp phone. Upsert: when a row
   * already exists for (tenantId, normalizedPhone) it is returned with
   * created=false — duplicate-safe under concurrency.
   */
  create: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      whatsappPhone: z.string().min(5).max(30),
      name: z.string().max(255).optional(),
      email: z.string().email().max(320).optional(),
      language: z.string().max(10).optional(),
      tags: z.array(z.string().max(64)).max(50).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const phone = normalizeWaPhone(input.whatsappPhone);
      if (!phone) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "whatsappPhone must contain digits" });
      }

      const [existing] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, input.tenantId), eq(customers.whatsappPhone, phone)))
        .limit(1);
      if (existing) return { customer: existing, created: false as const };

      const id = crypto.randomUUID();
      // onConflictDoNothing on the unique (tenantId, whatsappPhone) index:
      // a concurrent insert of the same phone loses the race silently and is
      // re-read below.
      await db
        .insert(customers)
        .values({
          id,
          tenantId: input.tenantId,
          whatsappPhone: phone,
          name: input.name ?? null,
          email: input.email ?? null,
          language: input.language ?? "en",
          tags: input.tags ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: [customers.tenantId, customers.whatsappPhone] });

      const [row] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, input.tenantId), eq(customers.whatsappPhone, phone)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Customer create failed" });
      return { customer: row, created: row.id === id };
    }),

  /** List customers for a tenant (most recent first). */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return db
        .select()
        .from(customers)
        .where(eq(customers.tenantId, input.tenantId))
        .orderBy(desc(customers.createdAt))
        .limit(input.limit)
        .offset(input.offset);
    }),
});
