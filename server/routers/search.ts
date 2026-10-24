/**
 * OpenSearch full-text search procedures
 */
import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { osIndex, osSearch } from "../opensearch";

// === W64 intelligence (R5) ===
/** Fire-and-forget search-query log (zero-result flag feeds the admin
 *  friction dashboard + catalog-gap signals). Fail-open, never throws. */
export async function logSearchQuery(opts: {
  tenantId: string;
  userId?: string | null;
  channel: string;
  query: string;
  resultsCount: number;
}): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const { searchQueries } = await import("../../drizzle/schema");
    const db = await getDb();
    if (!db) return;
    await db.insert(searchQueries).values({
      tenantId: opts.tenantId,
      userId: opts.userId ?? null,
      channel: opts.channel,
      query: opts.query.slice(0, 512),
      resultsCount: opts.resultsCount,
      zeroResult: opts.resultsCount === 0,
    });
  } catch (e: any) {
    console.warn("[search] query log failed (fail-open):", e?.message);
  }
}
// === END W64 intelligence (R5) ===

export const searchRouter = router({
  /** Full-text search across WhatsApp messages */
  messages: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      query: z.string().min(1),
      limit: z.number().default(20),
      from: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const results = await osSearch("wa_messages", input.query, input.tenantId, input.limit);
      // === W64 intelligence (R5) === log + zero-result flag (fire-and-forget)
      void logSearchQuery({ tenantId: input.tenantId, userId: String(ctx.user.id), channel: "web", query: input.query, resultsCount: results.length });
      return results;
    }),

  /** Index a WhatsApp message into OpenSearch */
  indexMessage: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      messageId: z.string(),
      from: z.string(),
      text: z.string(),
      timestamp: z.number(),
      direction: z.enum(["inbound", "outbound"]),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      // === W48 integrations (PERF-INT-8): indexing is best-effort and
      // fire-and-forget — OpenSearch latency must not land on this request
      // path (fail-soft: osIndex never throws). ===
      void osIndex("wa_messages", input.messageId, {
        tenantId: input.tenantId,
        from: input.from,
        text: input.text,
        timestamp: input.timestamp,
        direction: input.direction,
      }).catch(() => {});
      return { ok: true };
    }),

  /** Full-text search across orders */
  orders: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      query: z.string().min(1),
      limit: z.number().default(20),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const results = await osSearch("wa_orders", input.query, input.tenantId, input.limit);
      // === W64 intelligence (R5) === log + zero-result flag (fire-and-forget)
      void logSearchQuery({ tenantId: input.tenantId, userId: String(ctx.user.id), channel: "web", query: input.query, resultsCount: results.length });
      return results;
    }),
});

