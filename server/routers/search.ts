/**
 * OpenSearch full-text search procedures
 */
import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
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
    .query(async ({ input }) => {
      return osSearch("wa_messages", input.query, input.limit);
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
    .mutation(async ({ input }) => {
      await osIndex("wa_messages", input.messageId, {
        tenantId: input.tenantId,
        from: input.from,
        text: input.text,
        timestamp: input.timestamp,
        direction: input.direction,
      });
      return { ok: true };
    }),

  /** Full-text search across orders */
  orders: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      query: z.string().min(1),
      limit: z.number().default(20),
    }))
    .query(async ({ input }) => {
      return osSearch("wa_orders", input.query, input.limit);
    }),
});

