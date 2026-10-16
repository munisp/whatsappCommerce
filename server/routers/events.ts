// === W53 EVENTS (ticketing) ===
/**
 * events router — merchant event/ticket management (tenant-guarded via the
 * existing membership patterns: protectedProcedure + assertTenantAccess for
 * reads, assertMoneyAccess for money-adjacent mutations) and a public,
 * PII-scrubbed storefront listing for the chat/web storefronts.
 *
 * Purchase itself happens in chat (nlp.ts / useCases.ts USSD) via
 * services/events.purchaseTickets; the router exposes the merchant surface
 * plus a buyer-facing "my tickets" read.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  addTicketTypeTx,
  cancelEvent,
  checkInTicket,
  createEventTx,
  getEventForTenant,
  listBuyerTickets,
  listPublishedEvents,
  listSales,
  listTicketTypes,
  publishEvent,
} from "../services/events";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const coordsSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Public, PII-scrubbed event projection (no internal metadata/createdBy). */
function publicEvent(ev: any) {
  return {
    eventId: ev.id,
    title: ev.title,
    description: ev.description,
    venue: ev.venue,
    venueCoords: ev.venueCoords,
    imageUrl: ev.imageUrl,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    capacity: ev.capacity,
    status: ev.status,
  };
}

export const eventsRouter = router({
  // ── Merchant: event management ──────────────────────────────────────────
  createEvent: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      venue: z.string().max(300).optional(),
      venueCoords: coordsSchema.nullish(),
      imageUrl: z.string().url().max(2000).nullish(),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date().nullish(),
      capacity: z.number().int().positive().max(10_000_000).nullish(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      if (input.endsAt && input.endsAt.getTime() < input.startsAt.getTime()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "endsAt must be after startsAt" });
      }
      return createEventTx(db, { ...input, createdBy: String(ctx.user.id) });
    }),

  publishEvent: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), eventId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return publishEvent(db, input.tenantId, input.eventId);
    }),

  cancelEvent: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), eventId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      // Cancelling flags paid tickets for refunds — owner|operator bar.
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return cancelEvent(db, input.tenantId, input.eventId);
    }),

  addTicketType: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      eventId: z.string().uuid(),
      name: z.string().min(1).max(120),
      priceCents: z.number().int().min(0).max(1_000_000_000),
      currency: z.string().max(8).default("NGN"),
      quantity: z.number().int().positive().max(10_000_000),
      maxPerOrder: z.number().int().positive().max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return addTicketTypeTx(db, input);
    }),

  listEvents: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      status: z.enum(["draft", "published", "cancelled", "completed"]).optional(),
      limit: z.number().int().default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { events } = await import("../../drizzle/schema");
      const { and, eq, desc } = await import("drizzle-orm");
      return db.select().from(events)
        .where(input.status
          ? and(eq(events.tenantId, input.tenantId), eq(events.status, input.status))
          : eq(events.tenantId, input.tenantId))
        .orderBy(desc(events.createdAt))
        .limit(Math.min(Math.max(input.limit, 1), 200));
    }),

  sales: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), eventId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const ev = await getEventForTenant(db, input.tenantId, input.eventId);
      if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      const { types, tickets, revenueCents } = await listSales(db, input.tenantId, input.eventId);
      return {
        event: ev,
        ticketTypes: types,
        revenueCents,
        tickets: tickets.map((t) => ({
          ticketId: t.id, code: t.code, status: t.status,
          ticketTypeId: t.ticketTypeId, orderId: t.orderId,
          checkedInAt: t.checkedInAt, createdAt: t.createdAt,
        })),
      };
    }),

  /** Merchant / door staff: check a ticket in by code (claim-first). */
  checkIn: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), code: z.string().min(3).max(24) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const res = await checkInTicket(db, input.tenantId, input.code);
      if (!res.ok) {
        const msg = res.reason === "not_found"
          ? `No ticket with code ${input.code.toUpperCase()} for this store.`
          : res.reason === "already_checked_in"
            ? `Ticket ${input.code.toUpperCase()} was already checked in${res.ticket?.checkedInAt ? ` at ${res.ticket.checkedInAt.toISOString()}` : ""}.`
            : res.reason === "event_cancelled"
              ? `Ticket ${input.code.toUpperCase()} belongs to a cancelled event (${res.eventTitle}).`
              : `Ticket ${input.code.toUpperCase()} is ${res.ticket?.status} — not valid for entry.`;
        throw new TRPCError({ code: "CONFLICT", message: msg });
      }
      return res;
    }),

  // ── Public storefront surface (PII-scrubbed) ────────────────────────────
  listPublished: publicProcedure
    .input(z.object({ tenantId: z.string().min(1), limit: z.number().int().default(20) }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const rows = await listPublishedEvents(db, input.tenantId, input.limit);
      return rows.map(publicEvent);
    }),

  ticketTypes: publicProcedure
    .input(z.object({ tenantId: z.string().min(1), eventId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const ev = await getEventForTenant(db, input.tenantId, input.eventId);
      if (!ev || ev.status !== "published") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      }
      const types = await listTicketTypes(db, input.tenantId, input.eventId);
      return types.map((t) => ({
        ticketTypeId: t.id,
        name: t.name,
        priceCents: t.priceCents,
        currency: t.currency,
        remaining: Math.max(0, t.quantity - t.soldCount),
        maxPerOrder: t.maxPerOrder,
      }));
    }),

  /** Buyer self-service: their own tickets (buyer ref is the capability). */
  myTickets: publicProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      buyerCustomerId: z.string().min(3).max(64),
    }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const rows = await listBuyerTickets(db, input.tenantId, input.buyerCustomerId);
      return rows.map((t) => ({
        ticketId: t.id, eventId: t.eventId, code: t.code,
        status: t.status, checkedInAt: t.checkedInAt, createdAt: t.createdAt,
      }));
    }),
});
// === END W53 EVENTS ===
