// === W53 EVENTS (ticketing) ===
/**
 * events.ts — events + ticket types + issued tickets (mig 0174).
 *
 * Money rides the EXISTING orders/payments rail (donations.ts pattern): a
 * purchase claims ticket-type inventory claim-first inside a transaction,
 * creates a normal orders row (metadata.eventTicket marks it), and mints a
 * payment link via paymentIntents + initiateWithFallback (integer cents,
 * idempotency key event-ticket:<orderId>). paymentConfirm.ts is UNTOUCHED —
 * ticket issuance hangs off the post-commit receipt seam (receipts.ts calls
 * issueAndDeliverTicketsForOrder fire-and-forget, fail-open).
 *
 * Check-in is claim-first (status flip issued → checked_in in one UPDATE),
 * so a double check-in gets an honest "already checked in at …" response.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID, randomBytes } from "crypto";
import { getDb } from "../db";
import {
  eventTickets,
  eventTicketTypes,
  events,
  orderItems,
  orders,
  paymentIntents,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const EVENT_TICKET_CATEGORY = "event_ticket";

export type EventStatus = "draft" | "published" | "cancelled" | "completed";
export type TicketStatus = "issued" | "checked_in" | "cancelled" | "refunded";

// ─── Merchant: event CRUD ───────────────────────────────────────────────────

export async function createEventTx(db: Db, input: {
  tenantId: string;
  title: string;
  description?: string;
  venue?: string;
  venueCoords?: { latitude: number; longitude: number } | null;
  imageUrl?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  capacity?: number | null;
  metadata?: Record<string, unknown> | null;
  createdBy?: string | null;
}) {
  const [row] = await db.insert(events).values({
    tenantId: input.tenantId,
    title: input.title,
    description: input.description ?? null,
    venue: input.venue ?? null,
    venueCoords: input.venueCoords ?? null,
    imageUrl: input.imageUrl ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    status: "draft",
    capacity: input.capacity ?? null,
    metadata: input.metadata ?? null,
    createdBy: input.createdBy ?? null,
  }).returning();
  return row;
}

export async function getEventForTenant(db: Db, tenantId: string, eventId: string) {
  const [row] = await db.select().from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId))).limit(1);
  return row ?? null;
}

/** Claim-first status flip — only a draft event can publish. */
export async function publishEvent(db: Db, tenantId: string, eventId: string) {
  const [row] = await db.update(events)
    .set({ status: "published", updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId), eq(events.status, "draft")))
    .returning();
  if (!row) {
    const cur = await getEventForTenant(db, tenantId, eventId);
    if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
    throw new TRPCError({ code: "CONFLICT", message: `Event is ${cur.status} — only a draft can be published.` });
  }
  return row;
}

/**
 * Cancel an event: status flip (published|draft → cancelled), then every
 * live ticket (issued / checked_in) is flagged 'cancelled' and the event
 * metadata gets a refundsPending count so finance can sweep refunds through
 * the existing refund rail. Idempotent — re-cancelling is a no-op read.
 */
export async function cancelEvent(db: Db, tenantId: string, eventId: string) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.update(events)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(
        eq(events.id, eventId), eq(events.tenantId, tenantId),
        sql`${events.status} IN ('draft','published')`,
      ))
      .returning();
    if (!row) {
      // Read via the TRANSACTION handle — a bare-db read here would queue
      // behind our own open transaction on single-connection drivers
      // (PGlite/sim) and deadlock.
      const [cur] = await tx.select().from(events)
        .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId))).limit(1);
      if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      if (cur.status === "cancelled") {
        return { event: cur, cancelledTickets: 0, refundsPending: 0, alreadyCancelled: true };
      }
      throw new TRPCError({ code: "CONFLICT", message: `Event is ${cur.status} and cannot be cancelled.` });
    }
    const cancelled = await tx.update(eventTickets)
      .set({ status: "cancelled" })
      .where(and(
        eq(eventTickets.eventId, eventId), eq(eventTickets.tenantId, tenantId),
        sql`${eventTickets.status} IN ('issued','checked_in')`,
      ))
      .returning({ id: eventTickets.id, orderId: eventTickets.orderId });
    const refundsPending = new Set(cancelled.map((t) => t.orderId).filter(Boolean)).size;
    const [final] = await tx.update(events)
      .set({
        metadata: sql`COALESCE(${events.metadata}, '{}'::jsonb) || ${JSON.stringify({
          cancelledAt: now.toISOString(), refundsPending,
        })}::jsonb`,
        updatedAt: now,
      })
      .where(eq(events.id, eventId))
      .returning();
    return { event: final, cancelledTickets: cancelled.length, refundsPending, alreadyCancelled: false };
  });
}

export async function addTicketTypeTx(db: Db, input: {
  tenantId: string;
  eventId: string;
  name: string;
  priceCents: number;
  currency?: string;
  quantity: number;
  maxPerOrder?: number;
}) {
  const ev = await getEventForTenant(db, input.tenantId, input.eventId);
  if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
  if (ev.status === "cancelled" || ev.status === "completed") {
    throw new TRPCError({ code: "CONFLICT", message: `Cannot add ticket types to a ${ev.status} event.` });
  }
  const [row] = await db.insert(eventTicketTypes).values({
    tenantId: input.tenantId,
    eventId: input.eventId,
    name: input.name,
    priceCents: input.priceCents,
    currency: input.currency ?? "NGN",
    quantity: input.quantity,
    soldCount: 0,
    maxPerOrder: input.maxPerOrder ?? 10,
  }).returning();
  return row;
}

// ─── Public storefront reads ────────────────────────────────────────────────

export async function listPublishedEvents(db: Db, tenantId: string, limit = 20) {
  return db.select().from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.status, "published")))
    .orderBy(events.startsAt)
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function listTicketTypes(db: Db, tenantId: string, eventId: string) {
  return db.select().from(eventTicketTypes)
    .where(and(eq(eventTicketTypes.eventId, eventId), eq(eventTicketTypes.tenantId, tenantId)));
}

/** Merchant sales board: tickets + per-type totals for one event. */
export async function listSales(db: Db, tenantId: string, eventId: string) {
  const types = await listTicketTypes(db, tenantId, eventId);
  const tickets = await db.select().from(eventTickets)
    .where(and(eq(eventTickets.eventId, eventId), eq(eventTickets.tenantId, tenantId)));
  const byType = new Map(types.map((t) => [t.id, t]));
  const revenueCents = tickets
    .filter((t) => t.status === "issued" || t.status === "checked_in")
    .reduce((sum, t) => sum + (byType.get(t.ticketTypeId)?.priceCents ?? 0), 0);
  return { types, tickets, revenueCents };
}

// ─── Purchase (claim-first inventory + existing payment rail) ───────────────

export async function purchaseTickets(db: Db, input: {
  tenantId: string;
  eventId: string;
  ticketTypeId: string;
  qty: number;
  /** E.164 phone (WA/USSD/SMS) or "telegram:<chatId>" (TG). */
  buyerCustomerId: string;
}): Promise<{
  orderId: string; orderNumber: string; paymentUrl: string | null;
  totalCents: number; currency: string; ticketTypeName: string; eventTitle: string;
}> {
  const qty = Math.floor(input.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Quantity must be between 1 and 100." });
  }
  const now = new Date();
  const orderId = randomUUID();
  const orderNumber = `EVT-${now.getTime().toString(36).toUpperCase()}`;

  const { tt, ev } = await db.transaction(async (tx) => {
    const [ev] = await tx.select().from(events)
      .where(and(eq(events.id, input.eventId), eq(events.tenantId, input.tenantId)))
      .limit(1);
    if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "I couldn't find that event." });
    if (ev.status !== "published") {
      throw new TRPCError({ code: "CONFLICT", message: `That event is ${ev.status} — tickets aren't on sale.` });
    }
    const [type] = await tx.select().from(eventTicketTypes)
      .where(and(
        eq(eventTicketTypes.id, input.ticketTypeId),
        eq(eventTicketTypes.eventId, input.eventId),
        eq(eventTicketTypes.tenantId, input.tenantId),
      )).limit(1);
    if (!type) throw new TRPCError({ code: "NOT_FOUND", message: "I couldn't find that ticket type." });
    if (qty > type.maxPerOrder) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `You can buy at most ${type.maxPerOrder} × ${type.name} per order.` });
    }
    // Claim-first: one UPDATE that only lands while inventory remains.
    const [claimed] = await tx.update(eventTicketTypes)
      .set({ soldCount: sql`${eventTicketTypes.soldCount} + ${qty}`, updatedAt: now })
      .where(and(
        eq(eventTicketTypes.id, type.id),
        sql`${eventTicketTypes.soldCount} + ${qty} <= ${eventTicketTypes.quantity}`,
      ))
      .returning();
    if (!claimed) {
      const left = type.quantity - type.soldCount;
      throw new TRPCError({
        code: "CONFLICT",
        message: left <= 0
          ? `Sorry — ${type.name} is SOLD OUT.`
          : `Only ${left} × ${type.name} left — lower your quantity.`,
      });
    }
    // Whole-event capacity cap (across all types) — checked under the claim.
    if (ev.capacity != null) {
      const [sum] = await tx.select({ total: sql<number>`COALESCE(SUM(${eventTicketTypes.soldCount}), 0)::int` })
        .from(eventTicketTypes)
        .where(eq(eventTicketTypes.eventId, ev.id));
      if ((sum?.total ?? 0) > ev.capacity) {
        throw new TRPCError({ code: "CONFLICT", message: "Sorry — this event is at full capacity." });
      }
    }
    const totalCents = type.priceCents * qty;
    await tx.insert(orders).values({
      id: orderId,
      tenantId: input.tenantId,
      customerId: input.buyerCustomerId.slice(0, 36),
      orderNumber,
      status: "pending",
      totalAmount: (totalCents / 100).toFixed(2),
      currency: type.currency,
      paymentStatus: "unpaid",
      items: [{
        eventId: ev.id, ticketTypeId: type.id,
        productName: `${ev.title} — ${type.name}`,
        quantity: qty, unitPrice: type.priceCents / 100,
      }],
      metadata: {
        eventTicket: {
          eventId: ev.id, ticketTypeId: type.id, qty,
          buyerCustomerId: input.buyerCustomerId.slice(0, 64),
          purchasedAt: now.toISOString(),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(orderItems).values({
      id: randomUUID(),
      orderId,
      productId: `event:${ev.id}`.slice(0, 36),
      productName: `${ev.title} — ${type.name}`.slice(0, 255),
      quantity: qty,
      unitPrice: (type.priceCents / 100).toFixed(2),
      currency: type.currency,
    });
    return { tt: claimed, ev };
  });

  // Payment link via the existing chain (idempotent on event-ticket:<orderId>).
  const totalCents = tt.priceCents * qty;
  const paymentIntentId = randomUUID();
  const reference = `EVT-${now.getTime()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: input.tenantId,
    orderId,
    customerId: input.buyerCustomerId.slice(0, 36),
    amount: (totalCents / 100).toFixed(2),
    currency: tt.currency,
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: `event-ticket:${orderId}`,
    status: "pending",
    metadata: { kind: "event_ticket", eventId: ev.id, ticketTypeId: tt.id, qty },
    createdAt: now,
    updatedAt: now,
  });
  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(input.tenantId, {
      tenantId: input.tenantId,
      amountCents: totalCents,
      currency: tt.currency,
      reference,
      metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, kind: "event_ticket", orderId },
      customer: { phone: input.buyerCustomerId.replace(/^telegram:/i, "") },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "event_ticket", eventId: ev.id, ticketTypeId: tt.id, qty, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (e: any) {
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    console.warn("[events] payment link failed:", e?.message);
  }
  return {
    orderId, orderNumber, paymentUrl, totalCents,
    currency: tt.currency, ticketTypeName: tt.name, eventTitle: ev.title,
  };
}

// ─── Issue on payment confirm (post-commit receipt seam, fail-open) ─────────

function newTicketCode(): string {
  return `T-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Idempotent issuer: tickets already recorded for the order are returned
 * as-is (webhook replays never double-issue). Codes collide at 2^-32 per
 * ticket — one retry on a unique-violation covers it.
 */
export async function issueTicketsForOrder(db: Db, orderId: string) {
  const existing = await db.select().from(eventTickets).where(eq(eventTickets.orderId, orderId));
  if (existing.length > 0) return { tickets: existing, issued: false as const };

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const meta = (order?.metadata as Record<string, unknown> | null)?.eventTicket as
    { eventId?: string; ticketTypeId?: string; qty?: number; buyerCustomerId?: string } | undefined;
  if (!order || !meta?.eventId || !meta?.ticketTypeId || !meta?.qty) {
    return { tickets: [] as typeof existing, issued: false as const };
  }
  const qty = Math.min(Math.max(Math.floor(meta.qty), 1), 100);
  const buyer = (meta.buyerCustomerId ?? order.customerId).slice(0, 64);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rows = await db.insert(eventTickets).values(
        Array.from({ length: qty }, () => ({
          tenantId: order.tenantId,
          eventId: meta.eventId!,
          ticketTypeId: meta.ticketTypeId!,
          orderId,
          buyerCustomerId: buyer,
          code: newTicketCode(),
          status: "issued",
        })),
      ).returning();
      return { tickets: rows, issued: true as const };
    } catch (e: any) {
      if (!/unique|duplicate/i.test(String(e?.message ?? e))) throw e;
    }
  }
  throw new Error("ticket code generation collided repeatedly");
}

/**
 * Receipt-seam entry point: issue (idempotent) then deliver the codes to the
 * buyer on their channel (WA text / TG via channelParity). Fail-open — the
 * caller (receipts.ts post-commit block) wraps this in try/catch.
 */
export async function issueAndDeliverTicketsForOrder(db: Db, orderId: string): Promise<void> {
  const { tickets } = await issueTicketsForOrder(db, orderId);
  if (tickets.length === 0) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  const ev = await getEventForTenant(db, order.tenantId, tickets[0]!.eventId);
  const buyer = tickets[0]!.buyerCustomerId;
  const when = ev ? ev.startsAt.toISOString().replace("T", " ").slice(0, 16) : "";
  const lines = tickets.map((t, i) => `${i + 1}. ${t.code}`);
  const text =
    `🎟️ Your ticket${tickets.length > 1 ? "s" : ""} for *${ev?.title ?? "the event"}*` +
    (when ? ` (${when})` : "") + (ev?.venue ? ` at ${ev.venue}` : "") + ":\n" +
    lines.join("\n") +
    `\nShow the code${tickets.length > 1 ? "s" : ""} at the door. Order ${order.orderNumber}.`;
  const ref = /^telegram:/i.test(buyer)
    ? { channel: "telegram" as const, channelScopedId: buyer.replace(/^telegram:/i, "") }
    : { phone: buyer };
  try {
    const { sendCustomerText } = await import("./channelParity");
    await sendCustomerText(order.tenantId, ref as any, EVENT_TICKET_CATEGORY, text, {
      notifType: EVENT_TICKET_CATEGORY, orderId,
    });
  } catch (e: any) {
    console.warn("[events] ticket delivery failed:", e?.message);
  }
}

// ─── Check-in (claim-first) ─────────────────────────────────────────────────

export type CheckInResult =
  | { ok: true; ticket: typeof eventTickets.$inferSelect; eventTitle: string }
  | { ok: false; reason: "not_found" | "already_checked_in" | "void" | "event_cancelled"; ticket?: typeof eventTickets.$inferSelect; eventTitle?: string };

export async function checkInTicket(db: Db, tenantId: string, code: string): Promise<CheckInResult> {
  const normalized = code.trim().toUpperCase();
  const [claimed] = await db.update(eventTickets)
    .set({ status: "checked_in", checkedInAt: new Date() })
    .where(and(
      eq(eventTickets.tenantId, tenantId),
      eq(eventTickets.code, normalized),
      eq(eventTickets.status, "issued"),
    ))
    .returning();
  if (claimed) {
    const ev = await getEventForTenant(db, tenantId, claimed.eventId);
    return { ok: true, ticket: claimed, eventTitle: ev?.title ?? "" };
  }
  const [cur] = await db.select().from(eventTickets)
    .where(and(eq(eventTickets.tenantId, tenantId), eq(eventTickets.code, normalized)))
    .limit(1);
  if (!cur) return { ok: false, reason: "not_found" };
  const ev = await getEventForTenant(db, tenantId, cur.eventId);
  if (ev?.status === "cancelled") return { ok: false, reason: "event_cancelled", ticket: cur, eventTitle: ev.title };
  if (cur.status === "checked_in") return { ok: false, reason: "already_checked_in", ticket: cur, eventTitle: ev?.title };
  return { ok: false, reason: "void", ticket: cur, eventTitle: ev?.title };
}

/** Buyer self-service: their tickets for the storefront/chat "my tickets". */
export async function listBuyerTickets(db: Db, tenantId: string, buyerCustomerId: string) {
  const rows = await db.select().from(eventTickets)
    .where(and(eq(eventTickets.tenantId, tenantId), eq(eventTickets.buyerCustomerId, buyerCustomerId.slice(0, 64))));
  return rows;
}
// === END W53 EVENTS ===
