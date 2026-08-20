/**
 * server/services/locationInbound.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Inbound WhatsApp `location` message handling.
 *
 * Two paths:
 *  1. The buyer has an active checkout session awaiting a delivery address
 *     (nlpSessions.context.awaitingAddress === true) — the shared location is
 *     fed through the SAME deterministic checkout path as a typed address
 *     (nlp.processMessage), so fee quote, order creation and payment link are
 *     identical; afterwards the lat/lng coordinates are patched onto the
 *     order metadata (deliveryCoords) + shippingAddress so later shipments
 *     are mappable.
 *  2. No pending session — the location is saved as the customer's default
 *     delivery address on their latest nlp session context
 *     (context.deliveryAddress / deliveryCoords — the same "saved address"
 *     store the checkout flow already consults), creating a session if none
 *     exists, and a confirmation is returned.
 */

import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { nlpSessions, orders } from "../../drizzle/schema";
import { defaultRadiusKm, discoverNearby } from "./geoDiscovery";
import { formatDiscoveryMenu } from "./discoveryMenu";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface InboundLocation {
  latitude: number;
  longitude: number;
  name?: string | null;
  address?: string | null;
}

export interface LocationInboundOutcome {
  handled: boolean;
  reply?: string;
  orderCard?: { orderId: string; orderNumber: string; paymentUrl: string | null };
  savedAsDefault?: boolean;
  /** True when the pin was turned into a nearby-merchant discovery menu. */
  discoveryOffered?: boolean;
}

/** Human-readable address text for a shared location (what a typed address
 *  would have looked like). Guaranteed ≥ 6 chars so the deterministic
 *  checkout step accepts it. */
export function formatLocationAddress(loc: InboundLocation): string {
  const parts = [loc.name, loc.address].filter((p) => typeof p === "string" && p.trim().length > 0) as string[];
  if (parts.length > 0) return parts.join(", ");
  return `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`;
}

/** Find the buyer's most recent nlp session whose context awaits an address. */
export async function findSessionAwaitingAddress(
  db: Db,
  tenantId: string,
  waPhoneNumber: string,
): Promise<any | null> {
  const recent = await db.select().from(nlpSessions)
    .where(eq(nlpSessions.waPhoneNumber, waPhoneNumber))
    .orderBy(desc(nlpSessions.lastActivityAt))
    .limit(10)
    .catch(() => []);
  return recent.find(
    (s: any) => s.tenantId === tenantId && (s.context as any)?.awaitingAddress === true,
  ) ?? null;
}

/** Persist coordinates onto the just-created order (additive jsonb merge). */
export async function attachCoordsToOrder(
  db: Db,
  orderId: string,
  loc: InboundLocation,
): Promise<void> {
  const coords = {
    latitude: loc.latitude,
    longitude: loc.longitude,
    ...(loc.name ? { name: loc.name } : {}),
    ...(loc.address ? { address: loc.address } : {}),
  };
  await db.update(orders).set({
    metadata: sql`COALESCE(${orders.metadata}, '{}'::jsonb) || ${JSON.stringify({ deliveryCoords: coords })}::jsonb`,
    shippingAddress: sql`COALESCE(${orders.shippingAddress}, '{}'::jsonb) || ${JSON.stringify({ coords })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(orders.id, orderId));
}

/**
 * Save the location as the customer's default delivery address — the same
 * session-context store the checkout flow reads (`deliveryAddress`), plus
 * the coordinates for mapping.
 */
export async function saveDefaultAddress(
  db: Db,
  tenantId: string,
  waPhoneNumber: string,
  customerName: string | undefined,
  loc: InboundLocation,
): Promise<void> {
  const addressText = formatLocationAddress(loc);
  const coords = { latitude: loc.latitude, longitude: loc.longitude };
  const [latest] = await db.select().from(nlpSessions)
    .where(eq(nlpSessions.waPhoneNumber, waPhoneNumber))
    .orderBy(desc(nlpSessions.lastActivityAt))
    .limit(1)
    .catch(() => []);
  if (latest) {
    const ctx = { ...((latest.context as Record<string, unknown>) ?? {}), deliveryAddress: addressText, deliveryCoords: coords };
    await db.update(nlpSessions).set({ context: ctx, lastActivityAt: new Date() })
      .where(eq(nlpSessions.id, latest.id));
  } else {
    await db.insert(nlpSessions).values({
      tenantId,
      waPhoneNumber,
      customerName: customerName ?? null,
      state: "greeting",
      context: { deliveryAddress: addressText, deliveryCoords: coords },
      messageHistory: [],
      lastActivityAt: new Date(),
      createdAt: new Date(),
    });
  }
}

/**
 * Persist a discovery pin: keeps the existing default-address store
 * (`deliveryAddress` / `deliveryCoords` — the checkout flow reads it) AND
 * records `lastDiscovery` ({lat, lng, radiusKm}) so follow-up free-text
 * queries ("pharmacy near me", category picks) re-center on this pin.
 */
export async function saveDiscoveryLocation(
  db: Db,
  tenantId: string,
  waPhoneNumber: string,
  customerName: string | undefined,
  loc: InboundLocation,
  radiusKm: number,
): Promise<void> {
  const addressText = formatLocationAddress(loc);
  const coords = { latitude: loc.latitude, longitude: loc.longitude };
  const lastDiscovery = { lat: loc.latitude, lng: loc.longitude, radiusKm };
  const [latest] = await db.select().from(nlpSessions)
    .where(eq(nlpSessions.waPhoneNumber, waPhoneNumber))
    .orderBy(desc(nlpSessions.lastActivityAt))
    .limit(1)
    .catch(() => []);
  if (latest) {
    const ctx = {
      ...((latest.context as Record<string, unknown>) ?? {}),
      deliveryAddress: addressText,
      deliveryCoords: coords,
      lastDiscovery,
    };
    await db.update(nlpSessions).set({ context: ctx, lastActivityAt: new Date() })
      .where(eq(nlpSessions.id, latest.id));
  } else {
    await db.insert(nlpSessions).values({
      tenantId,
      waPhoneNumber,
      customerName: customerName ?? null,
      state: "greeting",
      context: { deliveryAddress: addressText, deliveryCoords: coords, lastDiscovery },
      messageHistory: [],
      lastActivityAt: new Date(),
      createdAt: new Date(),
    });
  }
}

/**
 * Full inbound-location pipeline. Exported for tests; the webhook calls it
 * inside the message loop (fast — one session read + the normal checkout
 * path, no LLM spend on the happy path).
 */
export async function handleInboundLocationMessage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  location: InboundLocation;
  customerName?: string;
}): Promise<LocationInboundOutcome> {
  const db = await getDb();
  if (!db) return { handled: false };
  const { tenantId, waPhoneNumber, location: loc } = opts;
  const addressText = formatLocationAddress(loc);

  const session = await findSessionAwaitingAddress(db, tenantId, waPhoneNumber);
  if (session) {
    // Continue checkout EXACTLY as the text-address path: feed the formatted
    // address through the deterministic checkout step of the NLP engine.
    const { appRouter } = await import("../routers");
    const caller = appRouter.createCaller({ user: null } as any);
    const nlpResult: any = await caller.nlp.processMessage({
      tenantId,
      waPhoneNumber,
      message: addressText,
      customerName: opts.customerName,
    });
    const orderCard = nlpResult?.orderCard as { orderId?: string; orderNumber?: string; paymentUrl?: string | null } | undefined;
    if (orderCard?.orderId) {
      await attachCoordsToOrder(db, orderCard.orderId, loc)
        .catch((e: any) => console.error("[location-inbound] coords patch failed:", e?.message));
    }
    return {
      handled: true,
      reply: nlpResult?.reply,
      orderCard: orderCard?.orderId && orderCard?.orderNumber
        ? { orderId: orderCard.orderId, orderNumber: orderCard.orderNumber, paymentUrl: orderCard.paymentUrl ?? null }
        : undefined,
    };
  }

  // No pending checkout — the shared pin doubles as a discovery request:
  // show nearby merchants around it. Zero results keep the original
  // save-as-default fallback unchanged.
  const radiusKm = defaultRadiusKm();
  const discovery = await discoverNearby(
    { lat: loc.latitude, lng: loc.longitude, radiusKm },
    db,
  ).catch((e: any) => {
    console.error("[location-inbound] discovery failed:", e?.message);
    return null;
  });
  if (discovery && discovery.items.length > 0) {
    await saveDiscoveryLocation(db, tenantId, waPhoneNumber, opts.customerName, loc, discovery.radiusKm);
    return {
      handled: true,
      discoveryOffered: true,
      reply: `${formatDiscoveryMenu(discovery.items, discovery.radiusKm)}\n\nReply with a category to filter, or tell me what you're looking for.`,
    };
  }

  // No pending checkout and nothing nearby — save as the customer's default
  // delivery address.
  await saveDefaultAddress(db, tenantId, waPhoneNumber, opts.customerName, loc);
  const label = loc.name || loc.address ? ` (${addressText})` : "";
  return {
    handled: true,
    savedAsDefault: true,
    reply: `📍 Thanks! I've saved this location${label} as your default delivery address — next time you order, just choose delivery and I'll use it.`,
  };
}
