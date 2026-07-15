import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, desc, and, ilike, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { whatsappTemplates, InsertWhatsappTemplate, templateVersions, templateApprovalHistory } from "../../drizzle/schema";

const DEMO_TENANT = "demo-tenant-001";
function getTenantId(ctx: { user: { tenantId?: string | null } }) {
  return ctx.user.tenantId ?? DEMO_TENANT;
}

const templateVariableSchema = z.object({
  name: z.string(),
  example: z.string().optional(),
  description: z.string().optional(),
});

const templateButtonSchema = z.object({
  type: z.enum(["url", "phone", "quick_reply"]),
  text: z.string(),
  url: z.string().optional(),
  payload: z.string().optional(),
});

const templateInputSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.enum(["order_confirmation", "shipping_update", "payment_reminder", "welcome", "promotion", "support", "custom"]),
  language: z.string().default("en"),
  headerText: z.string().max(255).optional(),
  bodyText: z.string().min(1),
  footerText: z.string().max(255).optional(),
  variables: z.array(templateVariableSchema).optional(),
  buttons: z.array(templateButtonSchema).optional(),
  isActive: z.boolean().default(true),
});

// Seed default templates for demo
const DEFAULT_TEMPLATES = [
  {
    name: "Order Confirmation",
    category: "order_confirmation" as const,
    language: "en",
    headerText: "🛍️ Order Confirmed!",
    bodyText: "Hi {{customer_name}}, your order *#{{order_number}}* has been confirmed!\n\n📦 Items: {{item_count}}\n💰 Total: {{currency}} {{total_amount}}\n\nWe'll notify you when it ships.",
    footerText: "Reply HELP for support",
    variables: [
      { name: "customer_name", example: "Amara", description: "Customer first name" },
      { name: "order_number", example: "ORD-2026-001", description: "Order reference number" },
      { name: "item_count", example: "3", description: "Number of items ordered" },
      { name: "currency", example: "USD", description: "Currency code" },
      { name: "total_amount", example: "89.99", description: "Order total amount" },
    ],
    buttons: [{ type: "url" as const, text: "Track Order", url: "https://shop.example.com/track/{{order_number}}" }],
  },
  {
    name: "Shipping Update",
    category: "shipping_update" as const,
    language: "en",
    headerText: "🚚 Your Order is on the Way!",
    bodyText: "Great news, {{customer_name}}! Order *#{{order_number}}* has been shipped.\n\n📬 Carrier: {{carrier}}\n🔍 Tracking: {{tracking_number}}\n📅 Est. Delivery: {{delivery_date}}",
    footerText: "Reply STOP to unsubscribe",
    variables: [
      { name: "customer_name", example: "Carlos", description: "Customer first name" },
      { name: "order_number", example: "ORD-2026-002", description: "Order reference" },
      { name: "carrier", example: "DHL Express", description: "Shipping carrier name" },
      { name: "tracking_number", example: "1234567890", description: "Tracking number" },
      { name: "delivery_date", example: "July 18, 2026", description: "Estimated delivery date" },
    ],
    buttons: [{ type: "url" as const, text: "Track Shipment", url: "https://track.dhl.com/{{tracking_number}}" }],
  },
  {
    name: "Payment Reminder",
    category: "payment_reminder" as const,
    language: "en",
    headerText: "💳 Payment Reminder",
    bodyText: "Hi {{customer_name}}, invoice *{{invoice_number}}* for *{{currency}} {{amount}}* is due on {{due_date}}.\n\nPlease complete your payment to avoid service interruption.",
    footerText: "Secure payment via our platform",
    variables: [
      { name: "customer_name", example: "Priya", description: "Customer first name" },
      { name: "invoice_number", example: "INV/2026/00203", description: "Invoice reference" },
      { name: "currency", example: "USD", description: "Currency code" },
      { name: "amount", example: "154.50", description: "Amount due" },
      { name: "due_date", example: "July 31, 2026", description: "Payment due date" },
    ],
    buttons: [
      { type: "url" as const, text: "Pay Now", url: "https://pay.example.com/{{invoice_number}}" },
      { type: "quick_reply" as const, text: "Need Help", payload: "PAYMENT_HELP" },
    ],
  },
  {
    name: "Welcome Message",
    category: "welcome" as const,
    language: "en",
    headerText: "👋 Welcome!",
    bodyText: "Hi {{customer_name}}! Welcome to *{{store_name}}* on WhatsApp.\n\nYou can:\n• 🛒 Browse our catalog\n• 📦 Track your orders\n• 💬 Chat with support\n\nType *MENU* to get started!",
    footerText: "Powered by WhatsApp Commerce",
    variables: [
      { name: "customer_name", example: "David", description: "Customer first name" },
      { name: "store_name", example: "TechMart Africa", description: "Store or business name" },
    ],
    buttons: [{ type: "quick_reply" as const, text: "Show Menu", payload: "SHOW_MENU" }],
  },
  {
    name: "Promotion Blast",
    category: "promotion" as const,
    language: "en",
    headerText: "🎉 Special Offer Just for You!",
    bodyText: "Hi {{customer_name}}! 🔥 *{{discount}}% OFF* on all {{category}} items this weekend only!\n\nUse code: *{{promo_code}}*\nValid until: {{expiry_date}}\n\nShop now before it's gone!",
    footerText: "Reply STOP to unsubscribe",
    variables: [
      { name: "customer_name", example: "Amara", description: "Customer first name" },
      { name: "discount", example: "25", description: "Discount percentage" },
      { name: "category", example: "Electronics", description: "Product category" },
      { name: "promo_code", example: "SAVE25", description: "Promotional code" },
      { name: "expiry_date", example: "July 20, 2026", description: "Offer expiry date" },
    ],
    buttons: [
      { type: "url" as const, text: "Shop Now", url: "https://shop.example.com/sale" },
      { type: "quick_reply" as const, text: "Not Interested", payload: "OPT_OUT_PROMO" },
    ],
  },
];

export const templateRouter = router({
  list: protectedProcedure
    .input(z.object({
      category: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { templates: [], total: 0 };
      const tenantId = getTenantId(ctx);

      // Auto-seed defaults if empty
      const count = await db.select({ c: sql<number>`count(*)` }).from(whatsappTemplates).where(eq(whatsappTemplates.tenantId, tenantId));
      if (Number(count[0]?.c ?? 0) === 0) {
        for (const t of DEFAULT_TEMPLATES) {
          await db.insert(whatsappTemplates).values({
            id: nanoid(),
            tenantId,
            name: t.name,
            category: t.category,
            language: t.language,
            headerText: t.headerText,
            bodyText: t.bodyText,
            footerText: t.footerText,
            variables: t.variables as any,
            buttons: t.buttons as any,
            isActive: true,
          });
        }
      }

      const conditions = [eq(whatsappTemplates.tenantId, tenantId)];
      if (input.category) conditions.push(eq(whatsappTemplates.category, input.category as any));
      if (input.search) conditions.push(ilike(whatsappTemplates.name, `%${input.search}%`));

      const templates = await db
        .select()
        .from(whatsappTemplates)
        .where(and(...conditions))
        .orderBy(desc(whatsappTemplates.usageCount), desc(whatsappTemplates.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      const totalRows = await db.select({ c: sql<number>`count(*)` }).from(whatsappTemplates).where(and(...conditions));

      return { templates, total: Number(totalRows[0]?.c ?? 0) };
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db.select().from(whatsappTemplates)
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))))
        .limit(1);
      return rows[0] ?? null;
    }),

  create: protectedProcedure
    .input(templateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const id = nanoid();
      const record: InsertWhatsappTemplate = {
        id,
        tenantId: getTenantId(ctx),
        name: input.name,
        category: input.category,
        language: input.language,
        headerText: input.headerText,
        bodyText: input.bodyText,
        footerText: input.footerText,
        variables: (input.variables ?? []) as any,
        buttons: (input.buttons ?? []) as any,
        isActive: input.isActive,
      };
      await db.insert(whatsappTemplates).values(record);
      return { id };
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string() }).merge(templateInputSchema.partial()))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const { id, ...rest } = input;
      await db.update(whatsappTemplates)
        .set({ ...rest, variables: rest.variables as any, buttons: rest.buttons as any, updatedAt: new Date() })
        .where(and(eq(whatsappTemplates.id, id), eq(whatsappTemplates.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.delete(whatsappTemplates)
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  // Toggle draft/published state
  toggleActive: protectedProcedure
    .input(z.object({ id: z.string(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(whatsappTemplates)
        .set({ isActive: input.isActive, updatedAt: new Date() })
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  // Record a usage (called when template is sent from Odoo/Twenty dialogs)
  recordUsage: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return;
      await db.update(whatsappTemplates)
        .set({ usageCount: sql<number>`"usageCount" + 1`, lastUsedAt: new Date() })
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  // Preview: substitute variables with example values
  preview: protectedProcedure
    .input(z.object({ id: z.string(), values: z.record(z.string(), z.string()).optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db.select().from(whatsappTemplates)
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))))
        .limit(1);
      const t = rows[0];
      if (!t) return null;

      const vars = (t.variables as Array<{ name: string; example?: string }> | null) ?? [];
      const substitutions: Record<string, string> = {};
      vars.forEach(v => { substitutions[v.name] = input.values?.[v.name] ?? v.example ?? `{{${v.name}}}`; });

      const substitute = (text: string | null | undefined) => {
        if (!text) return text;
        return text.replace(/\{\{(\w+)\}\}/g, (_, key) => substitutions[key] ?? `{{${key}}}`);
      };

      return {
        ...t,
        headerText: substitute(t.headerText),
        bodyText: substitute(t.bodyText),
        footerText: substitute(t.footerText),
      };
    }),

  // ── Submit template for Meta approval ─────────────────────────────────────
  submitForApproval: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // In production this would call the WhatsApp Business API to submit the template
      await db.update(whatsappTemplates)
        .set({
          approvalStatus: "submitted",
          approvalSubmittedAt: new Date(),
          approvalUpdatedAt: new Date(),
          updatedAt: new Date(),
        } as any)
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))));
      // Persist approval history event
      await db.insert(templateApprovalHistory).values({
        id: nanoid(),
        templateId: input.id,
        tenantId: getTenantId(ctx),
        fromStatus: "draft",
        toStatus: "submitted",
        changedBy: (ctx.user as any).name ?? ctx.user.openId ?? null,
        reason: null,
        metaSubmissionId: null,
        createdAt: new Date(),
      } as any);
      return { success: true, status: "submitted" };
    }),

  // ── Update approval status (webhook from Meta or manual) ──────────────────
  updateApprovalStatus: protectedProcedure
    .input(z.object({
      id: z.string(),
      status: z.enum(["none", "draft", "submitted", "approved", "rejected", "paused"]),
      rejectionReason: z.string().optional(),
      metaTemplateId: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(whatsappTemplates)
        .set({
          approvalStatus: input.status as any,
          approvalUpdatedAt: new Date(),
          rejectionReason: input.rejectionReason ?? null,
          metaTemplateId: input.metaTemplateId ?? null,
          // Auto-activate when approved
          isActive: input.status === "approved",
          updatedAt: new Date(),
        } as any)
        .where(and(eq(whatsappTemplates.id, input.id), eq(whatsappTemplates.tenantId, getTenantId(ctx))));
      // Persist approval history event
      await db.insert(templateApprovalHistory).values({
        id: nanoid(),
        templateId: input.id,
        tenantId: getTenantId(ctx),
        fromStatus: null,
        toStatus: input.status,
        changedBy: (ctx.user as any).name ?? ctx.user.openId ?? null,
        reason: input.rejectionReason ?? null,
        metaSubmissionId: input.metaTemplateId ?? null,
        createdAt: new Date(),
      } as any);
      return { success: true };
    }),

  // ── Get real approval history from dedicated history table ────────────────
  getApprovalHistoryReal: protectedProcedure
    .input(z.object({ templateId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db.select().from(templateApprovalHistory)
        .where(and(
          eq(templateApprovalHistory.templateId, input.templateId),
          eq(templateApprovalHistory.tenantId, getTenantId(ctx))
        ))
        .orderBy(desc(templateApprovalHistory.createdAt));
      return rows;
    }),

  // ── Get approval history (legacy: current state as single entry) ──────────
  getApprovalHistory: protectedProcedure
    .input(z.object({ templateId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const tpl = await db.select().from(whatsappTemplates)
        .where(and(eq(whatsappTemplates.id, input.templateId), eq(whatsappTemplates.tenantId, getTenantId(ctx))))
        .limit(1);
      if (!tpl[0]) return [];
      // Return current approval state as history entry
      return [{
        templateId: input.templateId,
        approvalStatus: (tpl[0] as any).approvalStatus,
        approvalSubmittedAt: (tpl[0] as any).approvalSubmittedAt,
        approvalUpdatedAt: (tpl[0] as any).approvalUpdatedAt,
        rejectionReason: (tpl[0] as any).rejectionReason,
        metaTemplateId: (tpl[0] as any).metaTemplateId,
      }];
    }),
});
