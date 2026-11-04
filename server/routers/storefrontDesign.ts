/**
 * Merchant storefront design: choose a template, edit a draft, publish. Always scoped to the session's
 * tenant, never a caller-supplied one. Changing the design only ever touches the storefront row.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { storefronts, storeNewsletterSubscribers, tenants } from "../../drizzle/schema";
import { applyTemplate, storeConfigSchema, type StoreConfig } from "../../shared/storefront/config";
import { findTemplate } from "../../shared/storefront/templates";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { getMembership } from "../services/membership";
import { buildDefaultSlug } from "../services/storefront";
import { defaultConfigFor, parseConfig, resolveWhatsapp, type Db } from "../services/storefront/store";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function tenantOf(ctx: { user: { tenantId?: string | null } }): string {
  if (!ctx.user.tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No shop on this account" });
  return ctx.user.tenantId;
}

/**
 * Owners and operators edit the design. The shop comes from the session, so unlike operatorProcedure this
 * needs no tenantId in the request. A single-user merchant with no membership row passes, as they do for
 * money actions (assertMoneyAccess); analysts and other read-only roles don't.
 */
const designProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const tenantId = tenantOf(ctx);
  const membership = await getMembership(ctx.user.id, tenantId).catch(() => null);
  const allowed = membership ? ["owner", "operator"].includes(membership.role) : !["analyst", "viewer"].includes(String(ctx.user.role));
  if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner or operator can change the store" });
  return next();
});

/** Every shop can design a store before going live, so the row is created on first use, hidden. */
async function ensureStorefront(db: Db, tenantId: string) {
  const [row] = await db.select().from(storefronts).where(eq(storefronts.tenantId, tenantId)).limit(1);
  if (row) return row;
  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  await db.insert(storefronts).values({ tenantId, slug: buildDefaultSlug(tenantId, tenant?.name ?? "shop"), isVisible: false })
    .onConflictDoNothing();
  const [created] = await db.select().from(storefronts).where(eq(storefronts.tenantId, tenantId)).limit(1);
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create your store" });
  return created;
}

const currentDraft = (row: typeof storefronts.$inferSelect): StoreConfig =>
  parseConfig(row.draftConfig) ?? parseConfig(row.publishedConfig) ?? defaultConfigFor(row);

const stateOf = (row: typeof storefronts.$inferSelect, tenant: Pick<typeof tenants.$inferSelect, "settings" | "slug" | "whatsappPhoneNumberId">) => {
  const draft = currentDraft(row);
  const published = parseConfig(row.publishedConfig);
  return {
    slug: row.slug,
    isVisible: row.isVisible,
    templateId: draft.templateId,
    publishedTemplateId: published?.templateId ?? null,
    draft,
    hasUnpublishedChanges: JSON.stringify(draft) !== JSON.stringify(published),
    publishedAt: row.publishedAt,
    draftUpdatedAt: row.draftUpdatedAt,
    /** Where WhatsApp buttons go if the merchant leaves their number empty. */
    defaultWhatsapp: resolveWhatsapp({ ...draft, contact: { ...draft.contact, whatsapp: "" } }, tenant),
  };
};

export const storefrontDesignRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const db = await requireDb();
    const row = await ensureStorefront(db, tenantId);
    const [tenant] = await db.select({ settings: tenants.settings, name: tenants.name, slug: tenants.slug, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return { ...stateOf(row, tenant ?? { settings: null, slug: null, whatsappPhoneNumberId: null }), businessName: tenant?.name ?? "" };
  }),

  saveDraft: designProcedure.input(z.object({ config: storeConfigSchema })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const row = await ensureStorefront(db, tenantOf(ctx));
    const now = new Date();
    await db.update(storefronts).set({ draftConfig: input.config, templateId: input.config.templateId, draftUpdatedAt: now, updatedAt: now })
      .where(eq(storefronts.id, row.id));
    return { savedAt: now };
  }),

  /** Replaces the draft's design. Business details carry over; products, customers and orders aren't involved. */
  applyTemplate: designProcedure.input(z.object({ templateId: z.string().max(40) })).mutation(async ({ ctx, input }) => {
    const template = findTemplate(input.templateId);
    if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "That template doesn't exist" });
    const db = await requireDb();
    const row = await ensureStorefront(db, tenantOf(ctx));
    const next = applyTemplate(template.config, parseConfig(row.draftConfig) ?? parseConfig(row.publishedConfig));
    const now = new Date();
    await db.update(storefronts).set({ draftConfig: next, templateId: template.id, draftUpdatedAt: now, updatedAt: now }).where(eq(storefronts.id, row.id));
    return { draft: next };
  }),

  /** Back to the template's own design, keeping business details. */
  resetToTemplate: designProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    const row = await ensureStorefront(db, tenantOf(ctx));
    const draft = currentDraft(row);
    const template = findTemplate(draft.templateId);
    if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "This design has no template to reset to" });
    const next = applyTemplate(template.config, draft);
    const now = new Date();
    await db.update(storefronts).set({ draftConfig: next, draftUpdatedAt: now, updatedAt: now }).where(eq(storefronts.id, row.id));
    return { draft: next };
  }),

  /** Throws away unpublished edits. */
  discardDraft: designProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    const row = await ensureStorefront(db, tenantOf(ctx));
    const published = parseConfig(row.publishedConfig);
    const now = new Date();
    await db.update(storefronts).set({ draftConfig: published, templateId: published?.templateId ?? null, draftUpdatedAt: now, updatedAt: now }).where(eq(storefronts.id, row.id));
    return { draft: published ?? defaultConfigFor(row) };
  }),

  publish: designProcedure.input(z.object({ makeVisible: z.boolean().default(true) }).optional()).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const row = await ensureStorefront(db, tenantOf(ctx));
    const draft = currentDraft(row);
    const now = new Date();
    await db.update(storefronts).set({
      publishedConfig: draft, draftConfig: draft, templateId: draft.templateId, publishedAt: now, updatedAt: now,
      ...(input?.makeVisible !== false ? { isVisible: true } : {}),
    }).where(eq(storefronts.id, row.id));
    return { publishedAt: now, slug: row.slug };
  }),

  uploadImage: designProcedure.input(z.object({
    base64: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES * 1.4)),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })).mutation(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    const buffer = Buffer.from(input.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (buffer.length > MAX_IMAGE_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "Images must be 8MB or smaller" });
    const { storagePut } = await import("../storage");
    const ext = input.mimeType === "image/png" ? "png" : input.mimeType === "image/webp" ? "webp" : "jpg";
    // tenant-branding is the public namespace: shoppers have no session to read these with.
    const { url } = await storagePut(`tenant-branding/${tenantId}/storefront/${randomUUID()}.${ext}`, buffer, input.mimeType);
    return { url };
  }),

  newsletterSubscribers: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db.select({ email: storeNewsletterSubscribers.email, createdAt: storeNewsletterSubscribers.createdAt })
      .from(storeNewsletterSubscribers).where(eq(storeNewsletterSubscribers.tenantId, tenantOf(ctx)))
      .orderBy(desc(storeNewsletterSubscribers.createdAt)).limit(1000);
  }),
});
