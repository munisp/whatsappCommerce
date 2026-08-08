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

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Shared upsert used by customers.create AND the WhatsApp webhook contact
 * auto-provisioning: normalize the phone (single normalization implementation
 * — waSender.normalizeWaPhone), return the existing row for
 * (tenantId, phone), otherwise create it race-safely. When
 * `nameIfEmpty` is provided and the existing row has no name, the display
 * name is filled in (webhook profile names only ever enrich, never
 * overwrite).
 */
export async function upsertCustomerByPhone(
  db: Db,
  input: { tenantId: string; whatsappPhone: string; name?: string; nameIfEmpty?: boolean },
): Promise<{ customer: typeof customers.$inferSelect; created: boolean }> {
  const phone = normalizeWaPhone(input.whatsappPhone);
  if (!phone) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "whatsappPhone must contain digits" });
  }

  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, input.tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1);
  if (existing) {
    if (input.name && input.nameIfEmpty && !existing.name) {
      await db
        .update(customers)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(customers.id, existing.id));
      existing.name = input.name;
    }
    return { customer: existing, created: false };
  }

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
      language: "en",
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
}

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

      const { customer, created } = await upsertCustomerByPhone(db, {
        tenantId: input.tenantId,
        whatsappPhone: input.whatsappPhone,
        name: input.name,
      });

      // Extra fields apply only to the row this call created — an existing
      // customer is returned untouched (upsert semantics).
      if (created && (input.email || input.language || input.tags)) {
        await db
          .update(customers)
          .set({
            ...(input.email ? { email: input.email } : {}),
            ...(input.language ? { language: input.language } : {}),
            ...(input.tags ? { tags: input.tags as unknown as Record<string, unknown> } : {}),
            updatedAt: new Date(),
          } as any)
          .where(eq(customers.id, customer.id));
        if (input.email) customer.email = input.email;
        if (input.language) customer.language = input.language;
        if (input.tags) customer.tags = input.tags;
      }
      return { customer, created };
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
