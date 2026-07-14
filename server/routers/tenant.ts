import { z } from "zod";
import { nanoid } from "nanoid";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import * as db from "../db";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

export const tenantRouter = router({
  list: adminProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }).optional())
    .query(async ({ input }) => {
      return db.getTenants(input?.limit, input?.offset);
    }),

  stats: adminProcedure.query(async () => {
    return db.getTenantStats();
  }),

  get: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const t = await db.getTenantById(input.id);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      return t;
    }),

  create: adminProcedure
    .input(z.object({
      name: z.string().min(2).max(255),
      slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/),
      plan: z.enum(["starter", "growth", "enterprise"]).default("starter"),
      defaultCurrency: z.string().length(3).default("USD"),
      defaultLanguage: z.string().default("en"),
      aiEnabled: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const id = nanoid();
      await db.createTenant({ id, ...input, status: "trial" });
      return { id, ...input };
    }),

  update: adminProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(2).max(255).optional(),
      plan: z.enum(["starter", "growth", "enterprise"]).optional(),
      status: z.enum(["active", "suspended", "trial", "churned"]).optional(),
      aiEnabled: z.boolean().optional(),
      aiModel: z.string().optional(),
      whatsappPhoneNumberId: z.string().optional(),
      whatsappBusinessAccountId: z.string().optional(),
      chatwootAccountId: z.string().optional(),
      chatwootApiToken: z.string().optional(),
      cogsRate: z.number().min(0).max(0.99).optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      await db.updateTenant(id, data);
      return { success: true };
    }),
});
