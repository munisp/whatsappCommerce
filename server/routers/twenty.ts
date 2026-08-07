import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  twentyIntegrations,
  twentyContacts,
  twentyDeals,
} from "../../drizzle/schema";

const DEMO_TENANT = "demo-tenant-001";

// ── helpers ──────────────────────────────────────────────────────────────────
function getTenantId(ctx: { user: { tenantId?: string | null } }) {
  return ctx.user.tenantId ?? DEMO_TENANT;
}

// Simulate a Twenty CRM API call (real impl would use fetch to baseUrl)
type TwentyContact = { id: string; name: string; email: string; phone: string; company: string; jobTitle: string; stage: string };
type TwentyDeal = { id: string; name: string; stage: string; amount: number; currency: string; contactId: string; probability: number };

async function simulateTwentyContacts(_baseUrl: string, _apiKey: string): Promise<TwentyContact[]> {
  return [
    { id: "tw-c-001", name: "Amara Nwosu", email: "amara@acme.io", phone: "+2348012345678", company: "Acme Ltd", jobTitle: "CEO", stage: "Customer" },
    { id: "tw-c-002", name: "Carlos Mendez", email: "carlos@techwave.co", phone: "+5491123456789", company: "TechWave", jobTitle: "CTO", stage: "Lead" },
    { id: "tw-c-003", name: "Priya Sharma", email: "priya@shopfast.in", phone: "+919876543210", company: "ShopFast", jobTitle: "Founder", stage: "Prospect" },
    { id: "tw-c-004", name: "David Osei", email: "david@goldcoast.gh", phone: "+233244123456", company: "GoldCoast Retail", jobTitle: "GM", stage: "Customer" },
    { id: "tw-c-005", name: "Fatima Al-Rashid", email: "fatima@souk.ae", phone: "+971501234567", company: "Souk Digital", jobTitle: "Director", stage: "Opportunity" },
  ];
}

async function simulateTwentyDeals(_baseUrl: string, _apiKey: string): Promise<TwentyDeal[]> {
  return [
    { id: "tw-d-001", name: "Acme Enterprise Deal", stage: "Proposal", amount: 45000, currency: "USD", contactId: "tw-c-001", probability: 70 },
    { id: "tw-d-002", name: "TechWave Platform License", stage: "Negotiation", amount: 28000, currency: "USD", contactId: "tw-c-002", probability: 85 },
    { id: "tw-d-003", name: "ShopFast Commerce Suite", stage: "Qualified", amount: 12000, currency: "USD", contactId: "tw-c-003", probability: 40 },
    { id: "tw-d-004", name: "GoldCoast Retail Expansion", stage: "Won", amount: 67000, currency: "USD", contactId: "tw-c-004", probability: 100 },
  ];
}

export const twentyRouter = router({
  // ── Configuration ──────────────────────────────────────────────────────────
  getConfig: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const tenantId = getTenantId(ctx);
    const rows = await db
      .select()
      .from(twentyIntegrations)
      .where(eq(twentyIntegrations.tenantId, tenantId))
      .limit(1);
    if (!rows[0]) return null;
    // Mask API key
    return { ...rows[0], apiKey: rows[0].apiKey ? "••••••••" + rows[0].apiKey.slice(-4) : "" };
  }),

  saveConfig: protectedProcedure
    .input(z.object({
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
      workspaceId: z.string().optional(),
      syncContacts: z.boolean().default(true),
      syncDeals: z.boolean().default(true),
      whatsappEnabled: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const existing = await db
        .select({ id: twentyIntegrations.id })
        .from(twentyIntegrations)
        .where(eq(twentyIntegrations.tenantId, tenantId))
        .limit(1);
      if (existing[0]) {
        await db
          .update(twentyIntegrations)
          .set({ ...input, status: "disconnected" })
          .where(eq(twentyIntegrations.tenantId, tenantId));
        return { id: existing[0].id };
      }
      const id = nanoid();
      await db.insert(twentyIntegrations).values({ id, tenantId, ...input, status: "disconnected" });
      return { id };
    }),

  testConnection: protectedProcedure
    .input(z.object({ baseUrl: z.string(), apiKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      // Simulate connection test — real impl: fetch(`${input.baseUrl}/metadata`, { headers: { Authorization: `Bearer ${input.apiKey}` } })
      const ok = input.baseUrl.startsWith("http") && input.apiKey.length > 4;
      const status = ok ? "connected" : "error";
      await db
        .update(twentyIntegrations)
        .set({ status })
        .where(eq(twentyIntegrations.tenantId, tenantId));
      return { success: ok, status };
    }),

  // Validate and persist connection settings for a tenant. Used by the admin
  // portal, which passes an explicit tenantId; falls back to the caller's
  // tenant when omitted. The admin form field `apiUrl` maps to the `baseUrl`
  // column on twenty_integrations.
  configure: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      apiUrl: z.string().url(),
      apiKey: z.string().min(1),
      workspaceId: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = input.tenantId ?? getTenantId(ctx);
      const config = {
        baseUrl: input.apiUrl,
        apiKey: input.apiKey,
        workspaceId: input.workspaceId || null,
      };
      const existing = await db
        .select({ id: twentyIntegrations.id })
        .from(twentyIntegrations)
        .where(eq(twentyIntegrations.tenantId, tenantId))
        .limit(1);
      if (existing[0]) {
        await db
          .update(twentyIntegrations)
          .set({ ...config, status: "disconnected" })
          .where(eq(twentyIntegrations.tenantId, tenantId));
        return { id: existing[0].id, success: true };
      }
      const id = nanoid();
      await db.insert(twentyIntegrations).values({ id, tenantId, ...config, status: "disconnected" });
      return { id, success: true };
    }),

  // Pull contacts (people) from the Twenty REST API for the configured tenant
  // and upsert them into twenty_contacts. Requires a saved configuration.
  syncContacts: protectedProcedure
    .input(z.object({ tenantId: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = input?.tenantId ?? getTenantId(ctx);
      const cfg = await db
        .select()
        .from(twentyIntegrations)
        .where(eq(twentyIntegrations.tenantId, tenantId))
        .limit(1);
      if (!cfg[0]) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_CONFIGURED: Twenty CRM is not configured for this tenant",
        });
      }

      type TwentyPerson = {
        id: string;
        name?: { firstName?: string | null; lastName?: string | null } | null;
        emails?: { primaryEmail?: string | null } | null;
        phones?: { primaryPhoneNumber?: string | null; primaryPhoneCountryCode?: string | null } | null;
        jobTitle?: string | null;
        companyId?: string | null;
      };
      const baseUrl = cfg[0].baseUrl.replace(/\/+$/, "");
      let people: TwentyPerson[];
      try {
        const resp = await fetch(`${baseUrl}/rest/people?limit=100`, {
          headers: { Authorization: `Bearer ${cfg[0].apiKey}`, Accept: "application/json" },
        });
        if (!resp.ok) {
          throw new TRPCError({
            code: resp.status === 401 || resp.status === 403 ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR",
            message: `Twenty API request failed with status ${resp.status}`,
          });
        }
        const body = (await resp.json()) as { data?: { people?: TwentyPerson[] } };
        people = body.data?.people ?? [];
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to reach Twenty API: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      let contactsSynced = 0;
      for (const p of people) {
        const name = [p.name?.firstName, p.name?.lastName].filter(Boolean).join(" ").trim();
        const phone = p.phones?.primaryPhoneNumber ?? "";
        const email = p.emails?.primaryEmail ?? "";
        await db
          .insert(twentyContacts)
          .values({
            id: nanoid(),
            tenantId,
            twentyId: p.id,
            name: name || email || phone || p.id,
            email,
            phone,
            company: "",
            jobTitle: p.jobTitle ?? "",
            stage: "Lead",
            whatsappPhone: phone,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [twentyContacts.tenantId, twentyContacts.twentyId],
            set: {
              name: name || email || phone || p.id,
              email,
              phone,
              jobTitle: p.jobTitle ?? "",
              syncedAt: new Date(),
            },
          });
        contactsSynced++;
      }

      await db
        .update(twentyIntegrations)
        .set({ lastSyncAt: new Date(), status: "connected" })
        .where(eq(twentyIntegrations.tenantId, tenantId));

      return { contactsSynced };
    }),

  // ── Sync ───────────────────────────────────────────────────────────────────
  syncAll: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const tenantId = getTenantId(ctx);
    const cfg = await db
      .select()
      .from(twentyIntegrations)
      .where(eq(twentyIntegrations.tenantId, tenantId))
      .limit(1);
    if (!cfg[0]) throw new Error("Twenty not configured");

    let contactsSynced = 0;
    let dealsSynced = 0;

    if (cfg[0].syncContacts) {
      const contacts = await simulateTwentyContacts(cfg[0].baseUrl, cfg[0].apiKey);
      for (const c of contacts) {
        const id = nanoid();
        await db
          .insert(twentyContacts)
          .values({
            id,
            tenantId,
            twentyId: c.id,
            name: c.name,
            email: c.email,
            phone: c.phone,
            company: c.company,
            jobTitle: c.jobTitle,
            stage: c.stage,
            whatsappPhone: c.phone,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [twentyContacts.tenantId, twentyContacts.twentyId],
            set: { name: c.name, email: c.email, phone: c.phone, company: c.company, jobTitle: c.jobTitle, stage: c.stage, syncedAt: new Date() },
          });
        contactsSynced++;
      }
    }

    if (cfg[0].syncDeals) {
      const deals = await simulateTwentyDeals(cfg[0].baseUrl, cfg[0].apiKey);
      for (const d of deals) {
        const id = nanoid();
        await db
          .insert(twentyDeals)
          .values({
            id,
            tenantId,
            twentyId: d.id,
            name: d.name,
            stage: d.stage,
            amount: String(d.amount),
            currency: d.currency,
            probability: d.probability,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [twentyDeals.tenantId, twentyDeals.twentyId],
            set: { name: d.name, stage: d.stage, amount: String(d.amount), probability: d.probability, syncedAt: new Date() },
          });
        dealsSynced++;
      }
    }

    await db
      .update(twentyIntegrations)
      .set({ lastSyncAt: new Date(), status: "connected" })
      .where(eq(twentyIntegrations.tenantId, tenantId));

    return { contactsSynced, dealsSynced };
  }),

  // ── Contacts ───────────────────────────────────────────────────────────────
  listContacts: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { contacts: [], total: 0 };
      const tenantId = getTenantId(ctx);
      const rows = await db
        .select()
        .from(twentyContacts)
        .where(eq(twentyContacts.tenantId, tenantId))
        .orderBy(desc(twentyContacts.syncedAt))
        .limit(input.limit)
        .offset(input.offset);
      return { contacts: rows, total: rows.length };
    }),

  // ── Deals ──────────────────────────────────────────────────────────────────
  listDeals: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { deals: [], total: 0 };
      const tenantId = getTenantId(ctx);
      const rows = await db
        .select()
        .from(twentyDeals)
        .where(eq(twentyDeals.tenantId, tenantId))
        .orderBy(desc(twentyDeals.syncedAt))
        .limit(input.limit)
        .offset(input.offset);
      return { deals: rows, total: rows.length };
    }),

  // ── WhatsApp Send ──────────────────────────────────────────────────────────
  sendWhatsApp: protectedProcedure
    .input(z.object({
      contactId: z.string(),
      message: z.string().min(1).max(4096),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      await db
        .update(twentyContacts)
        .set({ lastWhatsappAt: new Date() })
        .where(and(eq(twentyContacts.id, input.contactId), eq(twentyContacts.tenantId, tenantId)));
      // Real impl: POST to WhatsApp Business API
      return { success: true, sentAt: new Date() };
    }),
});
