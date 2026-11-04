/**
 * The delivery fee for a cart, used by both chat checkout and the web storefront so a shopper is never
 * shown one price and charged another. Cheapest enabled courier when one quotes, otherwise the zone rate
 * from the parcel's real weight and the merchant's delivery zones.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { merchantLocations, products } from "../../drizzle/schema";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";
import { quoteDeliveryFee } from "./deliveryQuote";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

export async function quoteDeliveryForCart(db: Db, opts: {
  tenantId: string;
  address: string | null;
  coords?: { latitude: number; longitude: number } | null;
  items: { productId: string; quantity: number }[];
  subtotal: number;
}) {
  let aggQuote: import("./delivery/service").AggregatedQuote | null = null;
  try {
    const { quoteOrderDelivery } = await import("./delivery/service");
    aggQuote = await quoteOrderDelivery(db, {
      tenantId: opts.tenantId,
      dropoffAddress: opts.address,
      ...(opts.coords ? { dropoffLat: opts.coords.latitude, dropoffLng: opts.coords.longitude } : {}),
      orderValueCents: toMinorUnitsExact(opts.subtotal),
    });
  } catch (e: unknown) {
    console.error("[delivery] aggregated quote failed (non-blocking):", (e as Error)?.message);
  }
  // Unknown-weight lines use the 1kg floor.
  let orderWeightKg = 0;
  let tenantDeliveryZones: { name: string }[] | null = null;
  try {
    const weightRows = await db.select({ id: products.id, weightKg: products.weightKg })
      .from(products)
      .where(inArray(products.id, opts.items.map((i) => i.productId)));
    const weightById = new Map(weightRows.map((r) => [r.id, Number(r.weightKg ?? 0)]));
    orderWeightKg = opts.items.reduce((sum, i) => {
      const w = weightById.get(i.productId);
      return sum + i.quantity * (w && w > 0 ? w : 1);
    }, 0);
    const [loc] = await db.select({ deliveryZones: merchantLocations.deliveryZones })
      .from(merchantLocations)
      .where(eq(merchantLocations.tenantId, opts.tenantId))
      .orderBy(desc(merchantLocations.createdAt))
      .limit(1);
    tenantDeliveryZones = (loc?.deliveryZones as { name: string }[] | null) ?? null;
  } catch (e: unknown) {
    console.warn("[delivery] weight/zone inputs failed (non-blocking):", (e as Error)?.message);
  }
  const quote: { fee: number; zone: string; carrier: string; estimatedDays?: number } = aggQuote
    ? { fee: aggQuote.feeMajor, zone: aggQuote.zone ?? "same_city", carrier: aggQuote.label }
    : quoteDeliveryFee({ address: opts.address, weightKg: orderWeightKg || undefined, deliveryZones: tenantDeliveryZones });
  return { aggQuote, quote };
}
