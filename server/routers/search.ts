/**
 * OpenSearch full-text search procedures
 */
import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { osIndex, osSearch } from "../opensearch";

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
      return osSearch("wa_messages", input.query, input.tenantId, input.limit);
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
      return osSearch("wa_orders", input.query, input.tenantId, input.limit);
    }),
});

