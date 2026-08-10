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
import {
  getTwentyIntegrationConfig,
  sendWhatsAppTextMessage,
  syncTenantIntegrationPointer,
  type TwentyIntegrationConfig,
} from "../services/integrationSync";
import { decryptSecret, encryptSecret } from "../services/crypto/secrets";

const DEMO_TENANT = "demo-tenant-001";

// ── helpers ──────────────────────────────────────────────────────────────────
function getTenantId(ctx: { user: { tenantId?: string | null } }) {
  return ctx.user.tenantId ?? DEMO_TENANT;
}

/**
 * Cross-tenant credential hijack guard: a requested tenantId must match the
 * caller's own tenant unless the caller is a platform admin.
 */
function assertTenantAccess(ctx: { user: { role: string; tenantId?: string | null } }, requestedTenant: string) {
  if (ctx.user.role === "admin") return;
  if (requestedTenant !== getTenantId(ctx)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Cannot manage Twenty CRM integration for another tenant",
    });
  }
}

// ── Twenty REST API types ─────────────────────────────────────────────────────
type TwentyPerson = {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: { primaryPhoneNumber?: string | null; primaryPhoneCountryCode?: string | null } | null;
  jobTitle?: string | null;
  companyId?: string | null;
};
type TwentyOpportunity = {
  id: string;
  name?: string | null;
  stage?: string | null;
  amount?: { amountMicros?: number | null; currencyCode?: string | null } | null;
  probability?: number | null;
  closeDate?: string | null;
  pointOfContactId?: string | null;
};

/** Real GET against the Twenty REST API. Throws honest errors. */
async function twentyRestGet<T>(
  cfg: TwentyIntegrationConfig,
  path: string,
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Twenty API GET ${path} failed with status ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json() as Promise<T>;
}

async function fetchTwentyPeople(cfg: TwentyIntegrationConfig): Promise<TwentyPerson[]> {
  const body = await twentyRestGet<{ data?: { people?: TwentyPerson[] } }>(cfg, "/rest/people?limit=100");
  return body.data?.people ?? [];
}

async function fetchTwentyOpportunities(cfg: TwentyIntegrationConfig): Promise<TwentyOpportunity[]> {
  const body = await twentyRestGet<{ data?: { opportunities?: TwentyOpportunity[] } }>(
    cfg,
    "/rest/opportunities?limit=100",
  );
  return body.data?.opportunities ?? [];
}

function personDisplayName(p: TwentyPerson): string {
  return [p.name?.firstName, p.name?.lastName].filter(Boolean).join(" ").trim();
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
    // Mask API key (decrypt the v1: envelope first so the last-4 hint is
    // meaningful; decryptSecret passes legacy plaintext through unchanged).
    const plainKey = rows[0].apiKey ? decryptSecret(rows[0].apiKey) : "";
    return { ...rows[0], apiKey: plainKey ? "••••••••" + plainKey.slice(-4) : "" };
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
      let id: string;
      // API key is a secret — encrypt at rest (v1: envelope); reads decrypt
      // transparently via decryptSecret (legacy plaintext passthrough).
      const stored = { ...input, apiKey: encryptSecret(input.apiKey) };
      if (existing[0]) {
        await db
          .update(twentyIntegrations)
          .set({ ...stored, status: "disconnected" })
          .where(eq(twentyIntegrations.tenantId, tenantId));
        id = existing[0].id;
      } else {
        id = nanoid();
        await db.insert(twentyIntegrations).values({ id, tenantId, ...stored, status: "disconnected" });
      }
      // Keep the tenant_integrations pointer row in step so the real sync
      // paths (integrationSync outbound) resolve this tenant's credentials.
      await syncTenantIntegrationPointer(tenantId, "twenty_crm", input.baseUrl, "pending");
      return { id };
    }),

  /**
   * Real connection test: GET /rest/people?limit=1 with the Bearer API key.
   * Returns the real error when the workspace is unreachable or the key is
   * rejected.
   */
  testConnection: protectedProcedure
    .input(z.object({ baseUrl: z.string(), apiKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const baseUrl = input.baseUrl.replace(/\/+$/, "");
      let status: "connected" | "error" = "error";
      let error: string | null = null;
      try {
        await twentyRestGet({ baseUrl, apiKey: input.apiKey, workspaceId: null }, "/rest/people?limit=1");
        status = "connected";
      } catch (err: any) {
        error = err?.message ?? String(err);
      }
      await db
        .update(twentyIntegrations)
        .set({ status })
        .where(eq(twentyIntegrations.tenantId, tenantId));
      await syncTenantIntegrationPointer(
        tenantId,
        "twenty_crm",
        baseUrl,
        status === "connected" ? "active" : "error",
        error,
      );
      return { success: status === "connected", status, error };
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
      assertTenantAccess(ctx, tenantId);
      const config = {
        baseUrl: input.apiUrl,
        // Encrypt at rest (v1: envelope) — integrationSync decrypts on read.
        apiKey: encryptSecret(input.apiKey),
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
        await syncTenantIntegrationPointer(tenantId, "twenty_crm", config.baseUrl, "pending");
        return { id: existing[0].id, success: true };
      }
      const id = nanoid();
      await db.insert(twentyIntegrations).values({ id, tenantId, ...config, status: "disconnected" });
      await syncTenantIntegrationPointer(tenantId, "twenty_crm", config.baseUrl, "pending");
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
      assertTenantAccess(ctx, tenantId);
      const cfg = await getTwentyIntegrationConfig(tenantId);
      if (!cfg) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_CONFIGURED: Twenty CRM is not configured for this tenant",
        });
      }

      let people: TwentyPerson[];
      try {
        people = await fetchTwentyPeople(cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({
          code: message.includes("status 401") || message.includes("status 403") ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR",
          message,
        });
      }

      let contactsSynced = 0;
      for (const p of people) {
        const name = personDisplayName(p);
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
      await syncTenantIntegrationPointer(tenantId, "twenty_crm", cfg.baseUrl, "active");

      return { contactsSynced };
    }),

  // ── Sync ───────────────────────────────────────────────────────────────────
  /**
   * Real pull from the Twenty REST API: people → twenty_contacts and
   * opportunities → twenty_deals.  Throws honest errors; never simulates.
   */
  syncAll: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const tenantId = getTenantId(ctx);
    const cfgRow = await db
      .select()
      .from(twentyIntegrations)
      .where(eq(twentyIntegrations.tenantId, tenantId))
      .limit(1);
    if (!cfgRow[0]) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "NOT_CONFIGURED: Twenty CRM is not configured for this tenant",
      });
    }
    const cfg = await getTwentyIntegrationConfig(tenantId);
    if (!cfg) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "NOT_CONFIGURED: Twenty CRM integration is missing baseUrl/apiKey",
      });
    }

    let contactsSynced = 0;
    let dealsSynced = 0;
    const errors: string[] = [];

    if (cfgRow[0].syncContacts) {
      try {
        const people = await fetchTwentyPeople(cfg);
        for (const p of people) {
          const name = personDisplayName(p);
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
              rawData: p,
              syncedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [twentyContacts.tenantId, twentyContacts.twentyId],
              set: {
                name: name || email || phone || p.id,
                email,
                phone,
                jobTitle: p.jobTitle ?? "",
                rawData: p,
                syncedAt: new Date(),
              },
            });
          contactsSynced++;
        }
      } catch (err: any) {
        errors.push(`contacts: ${err?.message ?? String(err)}`);
      }
    }

    if (cfgRow[0].syncDeals) {
      try {
        const opportunities = await fetchTwentyOpportunities(cfg);
        for (const d of opportunities) {
          const amountMicros = d.amount?.amountMicros ?? null;
          const amount = amountMicros !== null ? (amountMicros / 1_000_000).toFixed(2) : null;
          const closeDate = d.closeDate ? new Date(d.closeDate) : null;
          const values = {
            tenantId,
            twentyId: d.id,
            name: d.name ?? null,
            stage: d.stage ?? null,
            amount,
            currency: d.amount?.currencyCode ?? "USD",
            probability: d.probability ?? null,
            closeDate: closeDate && !isNaN(closeDate.getTime()) ? closeDate : null,
            rawData: d,
            syncedAt: new Date(),
          };
          await db
            .insert(twentyDeals)
            .values({ id: nanoid(), ...values })
            .onConflictDoUpdate({
              target: [twentyDeals.tenantId, twentyDeals.twentyId],
              set: {
                name: values.name,
                stage: values.stage,
                amount: values.amount,
                currency: values.currency,
                probability: values.probability,
                closeDate: values.closeDate,
                rawData: d,
                syncedAt: new Date(),
              },
            });
          dealsSynced++;
        }
      } catch (err: any) {
        errors.push(`deals: ${err?.message ?? String(err)}`);
      }
    }

    const allFailed =
      errors.length > 0 &&
      contactsSynced + dealsSynced === 0 &&
      (cfgRow[0].syncContacts || cfgRow[0].syncDeals);

    await db
      .update(twentyIntegrations)
      .set({ lastSyncAt: new Date(), status: allFailed ? "error" : "connected" })
      .where(eq(twentyIntegrations.tenantId, tenantId));
    await syncTenantIntegrationPointer(
      tenantId,
      "twenty_crm",
      cfg.baseUrl,
      allFailed ? "error" : "active",
      allFailed ? errors.join(" | ") : null,
    );

    return { contactsSynced, dealsSynced, errors };
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
  /**
   * Send a real WhatsApp text message (Meta Cloud API) to a synced Twenty
   * contact.  lastWhatsappAt is only updated after the Cloud API accepts the
   * message; missing WhatsApp credentials produce an honest NOT_CONFIGURED
   * error — nothing is faked.
   */
  sendWhatsApp: protectedProcedure
    .input(z.object({
      contactId: z.string(),
      message: z.string().min(1).max(4096),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);

      const [contact] = await db
        .select()
        .from(twentyContacts)
        .where(and(eq(twentyContacts.id, input.contactId), eq(twentyContacts.tenantId, tenantId)))
        .limit(1);
      if (!contact) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Twenty contact not found" });
      }

      let phone = contact.whatsappPhone || contact.phone || null;

      // Fall back to a live Twenty lookup when the local cache has no number.
      if (!phone) {
        const cfg = await getTwentyIntegrationConfig(tenantId);
        if (cfg) {
          try {
            const body = await twentyRestGet<{ data?: { person?: TwentyPerson } }>(
              cfg,
              `/rest/people/${contact.twentyId}`,
            );
            phone = body.data?.person?.phones?.primaryPhoneNumber ?? null;
          } catch (err: any) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Failed to resolve recipient from Twenty: ${err?.message ?? String(err)}`,
            });
          }
        }
      }

      if (!phone) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No phone number on this Twenty contact",
        });
      }

      const result = await sendWhatsAppTextMessage(phone, input.message);
      if (!result.sent) {
        throw new TRPCError({
          code: result.notConfigured ? "PRECONDITION_FAILED" : "INTERNAL_SERVER_ERROR",
          message: result.error,
        });
      }

      await db
        .update(twentyContacts)
        .set({ lastWhatsappAt: new Date() })
        .where(and(eq(twentyContacts.id, input.contactId), eq(twentyContacts.tenantId, tenantId)));
      return { success: true, sentAt: new Date(), wamid: result.wamid };
    }),
});
