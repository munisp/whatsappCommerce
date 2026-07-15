import { z } from "zod";
import { eq, desc, ilike, and, sql } from "drizzle-orm";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { operatorTemplates } from "../../drizzle/schema";

const templateInputSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.enum(["transactional", "marketing", "utility", "authentication", "custom"]),
  language: z.string().default("en"),
  headerText: z.string().max(255).optional(),
  bodyText: z.string().min(1),
  footerText: z.string().max(255).optional(),
  variables: z.array(z.string()).optional(),
  isActive: z.boolean().default(true),
  description: z.string().optional(),
});

export const operatorTemplatesRouter = router({
  // List all operator templates (any authenticated user can read)
  list: protectedProcedure
    .input(z.object({
      search: z.string().optional(),
      category: z.enum(["transactional", "marketing", "utility", "authentication", "custom", "all"]).default("all"),
      activeOnly: z.boolean().default(false),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const offset = (input.page - 1) * input.pageSize;

      const conditions = [];
      if (input.search) {
        conditions.push(ilike(operatorTemplates.name, `%${input.search}%`));
      }
      if (input.category !== "all") {
        conditions.push(eq(operatorTemplates.category, input.category));
      }
      if (input.activeOnly) {
        conditions.push(eq(operatorTemplates.isActive, true));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, [{ count }]] = await Promise.all([
        db.select().from(operatorTemplates)
          .where(where)
          .orderBy(desc(operatorTemplates.createdAt))
          .limit(input.pageSize)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(operatorTemplates).where(where),
      ]);

      return { items, total: count, page: input.page, pageSize: input.pageSize };
    }),

  // Get a single template by ID
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [tmpl] = await db.select().from(operatorTemplates).where(eq(operatorTemplates.id, input.id));
      if (!tmpl) throw new Error("Template not found");
      return tmpl;
    }),

  // Create a new operator template (admin only)
  create: adminProcedure
    .input(templateInputSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const id = crypto.randomUUID();
      const [created] = await db.insert(operatorTemplates).values({
        id,
        ...input,
        variables: input.variables ?? [],
      }).returning();
      return created;
    }),

  // Update an existing operator template (admin only)
  update: adminProcedure
    .input(z.object({
      id: z.string(),
      data: templateInputSchema.partial(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [updated] = await db.update(operatorTemplates)
        .set({ ...input.data, updatedAt: new Date() })
        .where(eq(operatorTemplates.id, input.id))
        .returning();
      if (!updated) throw new Error("Template not found");
      return updated;
    }),

  // Toggle active status (admin only)
  toggleActive: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [tmpl] = await db.select().from(operatorTemplates).where(eq(operatorTemplates.id, input.id));
      if (!tmpl) throw new Error("Template not found");
      const [updated] = await db.update(operatorTemplates)
        .set({ isActive: !tmpl.isActive, updatedAt: new Date() })
        .where(eq(operatorTemplates.id, input.id))
        .returning();
      return updated;
    }),

  // Delete a template (admin only)
  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.delete(operatorTemplates).where(eq(operatorTemplates.id, input.id));
      return { success: true };
    }),
});
