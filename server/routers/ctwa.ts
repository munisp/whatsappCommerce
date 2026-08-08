/**
 * ctwa router — click-to-WhatsApp deep links + QR campaigns (tenant admin).
 *
 * getLinks      — per-tenant wa.me deep links for the canned entry points
 *                 plus any configured campaigns, each with its token-guarded
 *                 QR PNG URL.
 * createCampaign— persist a keyword campaign and return its link + QR URL.
 * deleteCampaign— remove a campaign by id.
 *
 * The QR PNGs themselves are served by GET /api/ctwa/:tenantId/:campaignId.png
 * (token-guarded public endpoint in _core/index.ts).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { assertTenantAccess, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import {
  buildCtwaLink,
  createCtwaCampaign,
  ctwaQrUrl,
  DEFAULT_CTWA_CAMPAIGNS,
  parseCtwaCampaigns,
  tenantWaPhone,
} from "../services/ctwa";

const tenantInput = z.object({ tenantId: z.string().min(1).max(36) });

export const ctwaRouter = router({
  /** All CTWA entry points (canned + configured campaigns) with links + QR URLs. */
  getLinks: protectedProcedure
    .input(tenantInput)
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });

      const phone = tenantWaPhone(tenant.settings);
      const campaigns = parseCtwaCampaigns(tenant.settings);
      const configuredKeywords = new Set(campaigns.map((c) => c.keyword));

      const entries = [
        // Configured campaigns first.
        ...campaigns.map((c) => ({
          id: c.id,
          keyword: c.keyword,
          label: c.label,
          action: c.action,
          configured: true as const,
          link: phone ? buildCtwaLink(phone, c.keyword) : null,
          qrUrl: ctwaQrUrl(input.tenantId, c.id),
        })),
        // Canned entry points not yet configured as campaigns.
        ...DEFAULT_CTWA_CAMPAIGNS.filter((d) => !configuredKeywords.has(d.keyword)).map((d) => {
          const id = `default:${d.keyword}`;
          return {
            id,
            keyword: d.keyword,
            label: d.label,
            action: d.action,
            configured: false as const,
            link: phone ? buildCtwaLink(phone, d.keyword) : null,
            qrUrl: ctwaQrUrl(input.tenantId, id),
          };
        }),
      ];
      return { phone, entries };
    }),

  /** Create a keyword campaign → deep link + QR PNG. */
  createCampaign: protectedProcedure
    .input(
      tenantInput.extend({
        keyword: z.string().trim().min(1).max(60),
        label: z.string().trim().min(1).max(120),
        action: z.enum(["menu", "track", "support", "promo", "none"]).optional().default("none"),
        reply: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      try {
        return await createCtwaCampaign(db, input.tenantId, input);
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err).slice(0, 200) });
      }
    }),

  /** Remove a campaign by id. */
  deleteCampaign: protectedProcedure
    .input(tenantInput.extend({ campaignId: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const campaigns = parseCtwaCampaigns(tenant.settings).filter((c) => c.id !== input.campaignId);
      await db
        .update(tenants)
        .set({
          settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({ ctwa: { campaigns } })}::jsonb`,
          updatedAt: new Date(),
        } as any)
        .where(eq(tenants.id, input.tenantId));
      return { ok: true as const };
    }),
});
