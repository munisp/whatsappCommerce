// === W53 EVENTS ===
/** Shared seed/helpers for the W53 events/ticketing journeys. */
import { eq, desc } from "drizzle-orm";
import { TENANT_ID, type World } from "../world";

export interface SeedEventResult {
  eventId: string;
  title: string;
  types: Array<{ id: string; name: string; priceCents: number; quantity: number }>;
}

/** Seed a PUBLISHED event with ticket types straight through the service. */
export async function seedPublishedEvent(
  world: World,
  tag: string,
  opts: {
    imageUrl?: string | null;
    capacity?: number | null;
    types?: Array<{ name: string; priceCents: number; quantity: number; maxPerOrder?: number }>;
  } = {},
): Promise<SeedEventResult> {
  const svc = await import("../../server/services/events");
  const title = `W53 ${tag} Live Show`;
  const ev = await svc.createEventTx(world.db as any, {
    tenantId: TENANT_ID,
    title,
    description: `Seed event for ${tag}`,
    venue: "W53 Arena, Lagos",
    imageUrl: opts.imageUrl ?? null,
    startsAt: new Date(Date.now() + 7 * 86_400_000),
    endsAt: new Date(Date.now() + 7 * 86_400_000 + 3 * 3_600_000),
    capacity: opts.capacity ?? null,
  });
  await svc.publishEvent(world.db as any, TENANT_ID, ev.id);
  const types: SeedEventResult["types"] = [];
  for (const t of opts.types ?? [
    { name: "General", priceCents: 250_000, quantity: 50 },
    { name: "VIP", priceCents: 900_000, quantity: 10 },
  ]) {
    const row = await svc.addTicketTypeTx(world.db as any, {
      tenantId: TENANT_ID, eventId: ev.id, ...t,
    });
    types.push({ id: row.id, name: row.name, priceCents: row.priceCents, quantity: row.quantity });
  }
  return { eventId: ev.id, title, types };
}

/** Latest paymentIntents provider reference (paystack ref) for an order. */
export async function paymentRefForOrder(world: World, orderId: string): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const [row] = await world.db
    .select()
    .from(schema.paymentIntents)
    .where(eq(schema.paymentIntents.orderId, orderId))
    .orderBy(desc(schema.paymentIntents.createdAt))
    .limit(1);
  if (!row?.providerPaymentId) throw new Error(`no payment intent for order ${orderId}`);
  return row.providerPaymentId;
}

/** Latest event-ticket order for a buyer ref (customerId prefix match). */
export async function latestEventOrderForBuyer(world: World, buyerRef: string): Promise<any> {
  const schema = await import("../../drizzle/schema");
  const rows = await world.db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.customerId, buyerRef.slice(0, 36)))
    .orderBy(desc(schema.orders.createdAt))
    .limit(5);
  return rows.find((o) => (o.metadata as any)?.eventTicket) ?? null;
}
// === END W53 EVENTS ===
