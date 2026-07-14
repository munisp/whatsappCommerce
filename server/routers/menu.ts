import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, asc, desc } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  whatsappMenus,
  whatsappMenuItems,
  odooSyncedProducts,
  odooSyncedOrders,
  twentyContacts,
  twentyDeals,
} from "../../drizzle/schema";

const DEMO_TENANT = "demo-tenant-001";
function getTenantId(ctx: { user: { tenantId?: string | null } }) {
  return ctx.user.tenantId ?? DEMO_TENANT;
}

const menuItemInputSchema = z.object({
  parentId: z.string().nullable().optional(),
  type: z.enum(["section", "button", "list_item", "quick_reply", "catalog_link", "url"]),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  payload: z.string().optional(),
  url: z.string().optional(),
  sortOrder: z.number().default(0),
});

export const menuRouter = router({
  // ── List all menus for tenant ──────────────────────────────────────────────
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(whatsappMenus)
      .where(eq(whatsappMenus.tenantId, getTenantId(ctx)))
      .orderBy(desc(whatsappMenus.updatedAt));
  }),

  // ── Get single menu with items ─────────────────────────────────────────────
  get: protectedProcedure
    .input(z.object({ menuId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const tenantId = getTenantId(ctx);
      const menus = await db
        .select()
        .from(whatsappMenus)
        .where(and(eq(whatsappMenus.id, input.menuId), eq(whatsappMenus.tenantId, tenantId)))
        .limit(1);
      if (!menus[0]) return null;
      const items = await db
        .select()
        .from(whatsappMenuItems)
        .where(and(eq(whatsappMenuItems.menuId, input.menuId), eq(whatsappMenuItems.tenantId, tenantId)))
        .orderBy(asc(whatsappMenuItems.sortOrder));
      return { menu: menus[0], items };
    }),

  // ── Create menu ────────────────────────────────────────────────────────────
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1), description: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const id = nanoid();
      await db.insert(whatsappMenus).values({
        id,
        tenantId: getTenantId(ctx),
        name: input.name,
        description: input.description,
        status: "draft",
        version: 1,
        pushStatus: "idle",
      });
      return { id };
    }),

  // ── Update menu metadata ───────────────────────────────────────────────────
  update: protectedProcedure
    .input(z.object({ menuId: z.string(), name: z.string().optional(), description: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const { menuId, ...rest } = input;
      await db
        .update(whatsappMenus)
        .set(rest)
        .where(and(eq(whatsappMenus.id, menuId), eq(whatsappMenus.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  // ── Delete menu ────────────────────────────────────────────────────────────
  delete: protectedProcedure
    .input(z.object({ menuId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      await db
        .delete(whatsappMenuItems)
        .where(and(eq(whatsappMenuItems.menuId, input.menuId), eq(whatsappMenuItems.tenantId, tenantId)));
      await db
        .delete(whatsappMenus)
        .where(and(eq(whatsappMenus.id, input.menuId), eq(whatsappMenus.tenantId, tenantId)));
      return { success: true };
    }),

  // ── Add item ───────────────────────────────────────────────────────────────
  addItem: protectedProcedure
    .input(z.object({ menuId: z.string(), item: menuItemInputSchema }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const id = nanoid();
      await db.insert(whatsappMenuItems).values({
        id,
        menuId: input.menuId,
        tenantId: getTenantId(ctx),
        parentId: input.item.parentId ?? null,
        type: input.item.type,
        title: input.item.title,
        description: input.item.description,
        payload: input.item.payload,
        url: input.item.url,
        sortOrder: input.item.sortOrder,
      });
      return { id };
    }),

  // ── Update item ────────────────────────────────────────────────────────────
  updateItem: protectedProcedure
    .input(z.object({ itemId: z.string(), item: menuItemInputSchema }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db
        .update(whatsappMenuItems)
        .set({
          parentId: input.item.parentId ?? null,
          type: input.item.type,
          title: input.item.title,
          description: input.item.description,
          payload: input.item.payload,
          url: input.item.url,
          sortOrder: input.item.sortOrder,
        })
        .where(and(eq(whatsappMenuItems.id, input.itemId), eq(whatsappMenuItems.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  // ── Delete item ────────────────────────────────────────────────────────────
  deleteItem: protectedProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db
        .delete(whatsappMenuItems)
        .where(and(eq(whatsappMenuItems.id, input.itemId), eq(whatsappMenuItems.tenantId, getTenantId(ctx))));
      return { success: true };
    }),

  // ── Reorder items ──────────────────────────────────────────────────────────
  reorderItems: protectedProcedure
    .input(z.object({ items: z.array(z.object({ id: z.string(), sortOrder: z.number() })) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      for (const item of input.items) {
        await db
          .update(whatsappMenuItems)
          .set({ sortOrder: item.sortOrder })
          .where(and(eq(whatsappMenuItems.id, item.id), eq(whatsappMenuItems.tenantId, tenantId)));
      }
      return { success: true };
    }),

  // ── DATA SOURCES: Pull from Odoo + Twenty ─────────────────────────────────
  getDataSources: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { odooProducts: [], odooCategories: [], twentyContacts: [], twentyDeals: [] };
    const tenantId = getTenantId(ctx);

    // Odoo products (active, with stock info)
    const odooProds = await db
      .select({
        id: odooSyncedProducts.id,
        odooId: odooSyncedProducts.odooId,
        name: odooSyncedProducts.name,
        internalRef: odooSyncedProducts.internalRef,
        price: odooSyncedProducts.price,
        currency: odooSyncedProducts.currency,
        category: odooSyncedProducts.category,
        stockQty: odooSyncedProducts.stockQty,
        active: odooSyncedProducts.active,
      })
      .from(odooSyncedProducts)
      .where(and(eq(odooSyncedProducts.tenantId, tenantId), eq(odooSyncedProducts.active, true)))
      .orderBy(asc(odooSyncedProducts.name))
      .limit(200);

    // Unique categories from Odoo
    const categorySet = new Set<string>();
    for (const p of odooProds) {
      if (p.category) categorySet.add(p.category);
    }
    const odooCategories = Array.from(categorySet).map((c) => ({ name: c }));

    // Odoo recent orders (for order status menu items)
    const odooOrds = await db
      .select({
        id: odooSyncedOrders.id,
        name: odooSyncedOrders.name,
        partnerName: odooSyncedOrders.partnerName,
        state: odooSyncedOrders.state,
        amountTotal: odooSyncedOrders.amountTotal,
      })
      .from(odooSyncedOrders)
      .where(eq(odooSyncedOrders.tenantId, tenantId))
      .orderBy(desc(odooSyncedOrders.syncedAt))
      .limit(50);

    // Twenty contacts (for CRM-linked menu items)
    const twContacts = await db
      .select({
        id: twentyContacts.id,
        name: twentyContacts.name,
        company: twentyContacts.company,
        stage: twentyContacts.stage,
        whatsappPhone: twentyContacts.whatsappPhone,
      })
      .from(twentyContacts)
      .where(eq(twentyContacts.tenantId, tenantId))
      .orderBy(asc(twentyContacts.name))
      .limit(100);

    // Twenty deals (for deal-stage menu sections)
    const twDeals = await db
      .select({
        id: twentyDeals.id,
        name: twentyDeals.name,
        stage: twentyDeals.stage,
        amount: twentyDeals.amount,
        currency: twentyDeals.currency,
        probability: twentyDeals.probability,
      })
      .from(twentyDeals)
      .where(eq(twentyDeals.tenantId, tenantId))
      .orderBy(asc(twentyDeals.stage))
      .limit(100);

    return {
      odooProducts: odooProds,
      odooCategories,
      odooOrders: odooOrds,
      twentyContacts: twContacts,
      twentyDeals: twDeals,
    };
  }),

  // ── AUTO-POPULATE: Build menu items from Odoo+Twenty data ─────────────────
  autoPopulate: protectedProcedure
    .input(z.object({
      menuId: z.string(),
      sources: z.object({
        odooProductsByCategory: z.boolean().default(true),
        odooOrderStatus: z.boolean().default(true),
        twentyDealStages: z.boolean().default(false),
        twentyContactList: z.boolean().default(false),
      }),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);

      // Clear existing items first
      await db
        .delete(whatsappMenuItems)
        .where(and(eq(whatsappMenuItems.menuId, input.menuId), eq(whatsappMenuItems.tenantId, tenantId)));

      let sortOrder = 0;
      const insertItem = async (item: {
        parentId?: string | null;
        type: "section" | "button" | "list_item" | "quick_reply" | "catalog_link" | "url";
        title: string;
        description?: string;
        payload?: string;
      }) => {
        const id = nanoid();
        await db.insert(whatsappMenuItems).values({
          id,
          menuId: input.menuId,
          tenantId,
          parentId: item.parentId ?? null,
          type: item.type,
          title: item.title,
          description: item.description,
          payload: item.payload,
          sortOrder: sortOrder++,
        });
        return id;
      };

      // ── 1. Odoo Products by Category ──────────────────────────────────────
      if (input.sources.odooProductsByCategory) {
        const products = await db
          .select()
          .from(odooSyncedProducts)
          .where(and(eq(odooSyncedProducts.tenantId, tenantId), eq(odooSyncedProducts.active, true)))
          .orderBy(asc(odooSyncedProducts.category), asc(odooSyncedProducts.name))
          .limit(100);

        // Group by category
        const byCategory = new Map<string, typeof products>();
        for (const p of products) {
          const cat = p.category ?? "Products";
          if (!byCategory.has(cat)) byCategory.set(cat, []);
          byCategory.get(cat)!.push(p);
        }

        for (const [category, prods] of Array.from(byCategory.entries())) {
          const sectionId = await insertItem({
            type: "section",
            title: `🛍️ ${category}`,
            description: `${prods.length} product${prods.length !== 1 ? "s" : ""} available`,
          });
          for (const p of prods.slice(0, 10)) {
            const stockLabel = Number(p.stockQty) > 0 ? `In stock: ${p.stockQty}` : "Out of stock";
            await insertItem({
              parentId: sectionId,
              type: "list_item",
              title: p.name.slice(0, 24),
              description: `${p.currency ?? "USD"} ${Number(p.price ?? 0).toFixed(2)} · ${stockLabel}`,
              payload: `PRODUCT_${p.odooId}`,
            });
          }
        }
      }

      // ── 2. Odoo Order Status ──────────────────────────────────────────────
      if (input.sources.odooOrderStatus) {
        const sectionId = await insertItem({
          type: "section",
          title: "📦 Order Status",
          description: "Check your order status",
        });
        await insertItem({ parentId: sectionId, type: "quick_reply", title: "Track My Order", description: "Enter your order number", payload: "TRACK_ORDER" });
        await insertItem({ parentId: sectionId, type: "quick_reply", title: "Recent Orders", description: "View your last 5 orders", payload: "RECENT_ORDERS" });
        await insertItem({ parentId: sectionId, type: "quick_reply", title: "Return / Refund", description: "Start a return request", payload: "RETURN_REQUEST" });
      }

      // ── 3. Twenty Deal Stages ─────────────────────────────────────────────
      if (input.sources.twentyDealStages) {
        const deals = await db
          .select()
          .from(twentyDeals)
          .where(eq(twentyDeals.tenantId, tenantId))
          .orderBy(asc(twentyDeals.stage))
          .limit(50);

        const byStage = new Map<string, typeof deals>();
        for (const d of deals) {
          const stage = d.stage ?? "Pipeline";
          if (!byStage.has(stage)) byStage.set(stage, []);
          byStage.get(stage)!.push(d);
        }

        for (const [stage, stageDeals] of Array.from(byStage.entries())) {
          const sectionId = await insertItem({
            type: "section",
            title: `💼 ${stage}`,
            description: `${stageDeals.length} deal${stageDeals.length !== 1 ? "s" : ""}`,
          });
          for (const d of stageDeals.slice(0, 5)) {
            await insertItem({
              parentId: sectionId,
              type: "list_item",
              title: (d.name ?? "Deal").slice(0, 24),
              description: d.amount ? `${d.currency ?? "USD"} ${Number(d.amount).toLocaleString()} · ${d.probability ?? 0}%` : stage,
              payload: `DEAL_${d.id}`,
            });
          }
        }
      }

      // ── 4. Twenty Contact List ────────────────────────────────────────────
      if (input.sources.twentyContactList) {
        const contacts = await db
          .select()
          .from(twentyContacts)
          .where(eq(twentyContacts.tenantId, tenantId))
          .orderBy(asc(twentyContacts.name))
          .limit(30);

        const sectionId = await insertItem({
          type: "section",
          title: "👥 CRM Contacts",
          description: `${contacts.length} contacts from Twenty CRM`,
        });
        for (const c of contacts.slice(0, 10)) {
          await insertItem({
            parentId: sectionId,
            type: "list_item",
            title: (c.name ?? "Contact").slice(0, 24),
            description: `${c.company ?? ""} · ${c.stage ?? ""}`.trim().replace(/^·\s*/, ""),
            payload: `CONTACT_${c.id}`,
          });
        }
      }

      // Always add a support section at the end
      const supportId = await insertItem({
        type: "section",
        title: "💬 Support",
        description: "Get help from our team",
      });
      await insertItem({ parentId: supportId, type: "quick_reply", title: "Talk to Agent", payload: "HUMAN_HANDOFF" });
      await insertItem({ parentId: supportId, type: "quick_reply", title: "FAQs", payload: "FAQ" });

      return { success: true, itemsCreated: sortOrder };
    }),

  // ── Publish menu ───────────────────────────────────────────────────────────
  publish: protectedProcedure
    .input(z.object({ menuId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      await db
        .update(whatsappMenus)
        .set({ status: "published", publishedAt: new Date() })
        .where(and(eq(whatsappMenus.id, input.menuId), eq(whatsappMenus.tenantId, tenantId)));
      return { success: true };
    }),

  // ── Push to WhatsApp ───────────────────────────────────────────────────────
  pushToWhatsApp: protectedProcedure
    .input(z.object({ menuId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);

      await db
        .update(whatsappMenus)
        .set({ pushStatus: "pushing" })
        .where(and(eq(whatsappMenus.id, input.menuId), eq(whatsappMenus.tenantId, tenantId)));

      const items = await db
        .select()
        .from(whatsappMenuItems)
        .where(and(eq(whatsappMenuItems.menuId, input.menuId), eq(whatsappMenuItems.tenantId, tenantId)))
        .orderBy(asc(whatsappMenuItems.sortOrder));

      const sections = items.filter((i) => i.type === "section");
      const waPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "Welcome! 👋" },
          body: { text: "Please select an option from the menu below:" },
          footer: { text: "Powered by WhatsApp Commerce" },
          action: {
            button: "Open Menu",
            sections: sections.map((section) => ({
              title: section.title,
              rows: items
                .filter((i) => i.parentId === section.id)
                .slice(0, 10)
                .map((row) => ({
                  id: row.payload ?? row.id,
                  title: row.title.slice(0, 24),
                  description: (row.description ?? "").slice(0, 72),
                })),
            })).filter((s) => s.rows.length > 0),
          },
        },
      };

      // Real impl: POST to https://graph.facebook.com/v19.0/{phone_number_id}/messages
      await new Promise((r) => setTimeout(r, 600));

      await db
        .update(whatsappMenus)
        .set({ pushStatus: "success", lastPushedAt: new Date(), status: "published", publishedAt: new Date() })
        .where(and(eq(whatsappMenus.id, input.menuId), eq(whatsappMenus.tenantId, tenantId)));

      return { success: true, payload: waPayload, pushedAt: new Date(), itemCount: items.length };
    }),

  // ── Unpublish ──────────────────────────────────────────────────────────────
  unpublish: protectedProcedure
    .input(z.object({ menuId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      await db
        .update(whatsappMenus)
        .set({ status: "draft", pushStatus: "idle" })
        .where(and(eq(whatsappMenus.id, input.menuId), eq(whatsappMenus.tenantId, tenantId)));
      return { success: true };
    }),
});
