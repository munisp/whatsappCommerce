/**
 * server/services/delivery/localDispatch.ts — W27 built-in mock/local-dispatch
 * courier adapter.
 *
 * Models a merchant's own rider pool ("local dispatch"): fully deterministic
 * quotes computed from the great-circle distance between the merchant's
 * branch (merchant_locations, Wave 25) and the buyer's dropoff pin. When no
 * coordinates are available the adapter falls back to the honest zone rate
 * from services/deliveryQuote.ts (same published-carrier anchors), converted
 * to integer cents.
 *
 * Deterministic: ids are derived via shared/prng.ts seeded on request
 * fields — no Math.random, no wall-clock dependence in pricing.
 */
import { createHash } from "node:crypto";
import { haversineKm } from "../geoDiscovery";
import { quoteDeliveryFee } from "../deliveryQuote";
import { seededRng } from "../../../shared/prng";
import type {
  BookRequest,
  Booking,
  CourierAdapter,
  DeliveryStatus,
  Quote,
  QuoteRequest,
} from "./types";

/** ₦350 flagfall + ₦120/km — typical Lagos moto-dispatch economics, integer cents. */
export const LOCAL_BASE_FEE_CENTS = 35_000;
export const LOCAL_PER_KM_CENTS = 12_000;
/** ₦50/kg beyond the first kilogram. */
export const LOCAL_PER_KG_CENTS = 5_000;
/** Average moto speed used for ETA (km/h) + fixed handling minutes. */
export const LOCAL_SPEED_KMH = 22;
export const LOCAL_HANDLING_MINUTES = 15;

function stableId(prefix: string, parts: unknown[]): string {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
  return `${prefix}_${h}`;
}

/** Deterministic quote. Distances round to 0.1 km so float noise never moves the fee. */
export function quoteLocalDispatch(req: QuoteRequest): Quote {
  const currency = req.currency ?? "NGN";
  const weightKg = Math.max(1, Math.ceil(req.weightKg ?? 1));
  let distanceKm: number | null = null;
  let feeCents: number;

  if (req.pickup && req.dropoff) {
    distanceKm = Math.round(haversineKm(req.pickup.lat, req.pickup.lng, req.dropoff.lat, req.dropoff.lng) * 10) / 10;
    feeCents = LOCAL_BASE_FEE_CENTS
      + Math.ceil(distanceKm) * LOCAL_PER_KM_CENTS
      + (weightKg - 1) * LOCAL_PER_KG_CENTS;
  } else {
    // No coordinates — honest fallback zone rate (NGN major → cents).
    const zone = quoteDeliveryFee({ address: req.dropoffAddress, weightKg });
    feeCents = Math.round(zone.fee * 100);
    distanceKm = null;
  }

  const etaMinutes = LOCAL_HANDLING_MINUTES
    + (distanceKm != null ? Math.ceil((distanceKm / LOCAL_SPEED_KMH) * 60) : 45);

  return {
    courier: "local_dispatch",
    quoteId: stableId("lq", [
      req.tenantId,
      req.pickup?.lat ?? null, req.pickup?.lng ?? null,
      req.dropoff?.lat ?? null, req.dropoff?.lng ?? null,
      req.dropoffAddress ?? null, weightKg,
    ]),
    feeCents,
    currency,
    distanceKm,
    etaMinutes,
    label: distanceKm != null
      ? `Local moto dispatch · ${distanceKm.toFixed(1)} km`
      : "Local moto dispatch · zone estimate",
  };
}

export const localDispatchAdapter: CourierAdapter = {
  id: "local_dispatch",
  displayName: "Local Moto Dispatch (built-in)",

  async quote(req: QuoteRequest): Promise<Quote> {
    return quoteLocalDispatch(req);
  },

  async book(req: BookRequest): Promise<Booking> {
    // Deterministic dispatch id + rider label, seeded on the order.
    const rng = seededRng(`local-dispatch:${req.orderId}`);
    const riderNum = 1 + Math.floor(rng() * 20);
    return {
      courier: "local_dispatch",
      externalId: stableId("ld", [req.orderId, req.quote.quoteId]),
      status: "booked",
      riderLabel: `Rider #${riderNum}`,
      raw: { simulated: true },
    };
  },

  async status(externalId: string): Promise<DeliveryStatus> {
    // The mock courier has no live feed: status is advanced by the merchant /
    // simulation via the deliveries table; status() just echoes the last known
    // booking state so syncDeliveryStatus stays a no-op unless progressed.
    return {
      courier: "local_dispatch",
      externalId,
      status: "booked",
      at: new Date().toISOString(),
      raw: { simulated: true },
    };
  },
};
