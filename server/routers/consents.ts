/**
 * consents.ts — tenant-visible messaging consent management (W17 F8).
 *
 * Surfaces the existing NDPR consent store (server/services/consent.ts) to
 * tenant users: list consent states, export CSV-ready rows, record withdrawals
 * (sets withdrawnAt + granted=false — the broadcast/journey send gates treat
 * withdrawnAt as a hard block), and opt-in stats by scope.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { consents } from "../../drizzle/schema";

const channelSchema = z.string().min(1).max(30).default("whatsapp");

export const consentsRouter = router({
  // ── List consent states for the tenant ────────────────────────────────────
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      channel: channelSchema.optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(consents.tenantId, input.tenantId)];
      if (input.channel) conds.push(eq(consents.channel, input.channel));
      return db.select().from(consents)
        .where(and(...conds))
        .orderBy(desc(consents.updatedAt))
        .limit(input.limit);
    }),

  // ── CSV-ready export (array of flat row objects) ──────────────────────────
  exportCsv: protectedProcedure
    .input(z.object({ tenantId: z.string(), channel: channelSchema.optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { headers: [] as string[], rows: [] as Record<string, string>[] };
      const conds = [eq(consents.tenantId, input.tenantId)];
      if (input.channel) conds.push(eq(consents.channel, input.channel));
      const rows = await db.select().from(consents)
        .where(and(...conds))
        .orderBy(desc(consents.updatedAt))
        .limit(5000);
      const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : "");
      return {
        headers: ["phone", "channel", "scope", "granted", "grantedAt", "source", "withdrawnAt", "updatedAt"],
        rows: rows.map((r) => ({
          phone: r.phone,
          channel: r.channel,
          scope: r.scope ?? "marketing",
          granted: r.granted ? "true" : "false",
          grantedAt: iso(r.grantedAt ?? (r.granted ? r.createdAt : null)),
          source: r.source ?? "",
          withdrawnAt: iso(r.withdrawnAt),
          updatedAt: iso(r.updatedAt),
        })),
      };
    }),

  // ── Opt-in stats: grant/withdrawal rates grouped by scope ─────────────────
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string(), channel: channelSchema.optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { scopes: [], totals: { granted: 0, withdrawn: 0, denied: 0 } };
      const channel = input.channel ?? "whatsapp";
      try {
        const res: any = await db.execute(sql`
          SELECT COALESCE(scope, 'marketing') AS scope,
                 COUNT(*) FILTER (WHERE granted = true AND withdrawn_at IS NULL) AS active,
                 COUNT(*) FILTER (WHERE withdrawn_at IS NOT NULL) AS withdrawn,
                 COUNT(*) FILTER (WHERE granted = false AND withdrawn_at IS NULL) AS denied,
                 COUNT(*) AS total
          FROM consents
          WHERE tenant_id = ${input.tenantId} AND channel = ${channel}
          GROUP BY COALESCE(scope, 'marketing')
          ORDER BY scope
        `);
        const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
        const scopes = rows.map((r) => {
          const total = Number(r.total) || 0;
          const active = Number(r.active) || 0;
          const withdrawn = Number(r.withdrawn) || 0;
          return {
            scope: String(r.scope),
            total,
            active,
            withdrawn,
            denied: Number(r.denied) || 0,
            grantRate: total ? Math.round((active / total) * 1000) / 10 : 0,
            withdrawalRate: total ? Math.round((withdrawn / total) * 1000) / 10 : 0,
          };
        });
        return {
          scopes,
          totals: {
            granted: scopes.reduce((a, s) => a + s.active, 0),
            withdrawn: scopes.reduce((a, s) => a + s.withdrawn, 0),
            denied: scopes.reduce((a, s) => a + s.denied, 0),
          },
        };
      } catch (e: any) {
        console.warn("[consents] stats query failed:", e?.message);
        return { scopes: [], totals: { granted: 0, withdrawn: 0, denied: 0 } };
      }
    }),

  // ── Record a withdrawal (tenant-side STOP handling) ───────────────────────
  // Sets withdrawnAt + granted=false. The broadcast audience builder and the
  // journey tick both treat withdrawnAt as a hard send block; a future YES
  // reply re-grants (recordConsent clears withdrawnAt).
  recordWithdrawal: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      phone: z.string().min(5).max(30),
      channel: channelSchema.optional(),
      scope: z.string().min(1).max(40).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const channel = input.channel ?? "whatsapp";
      const now = new Date();
      const [existing] = await db.select().from(consents)
        .where(and(
          eq(consents.tenantId, input.tenantId),
          eq(consents.phone, input.phone),
          eq(consents.channel, channel),
        ))
        .limit(1);
      if (existing) {
        await db.update(consents)
          .set({ granted: false, withdrawnAt: now, updatedAt: now })
          .where(eq(consents.id, existing.id));
        return { id: existing.id, withdrawnAt: now, updated: true };
      }
      const [inserted] = await db.insert(consents).values({
        tenantId: input.tenantId,
        phone: input.phone,
        channel,
        scope: input.scope ?? "marketing",
        source: "tenant_dashboard",
        granted: false,
        withdrawnAt: now,
      }).returning({ id: consents.id });
      return { id: inserted?.id ?? null, withdrawnAt: now, updated: false };
    }),
});
