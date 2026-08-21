/**
 * server/services/delivery/types.ts — W27 delivery aggregation contracts.
 *
 * FROZEN CONTRACT (SPEC_W27): pluggable courier adapter interface.
 *   interface CourierAdapter {quote(req): Promise<Quote>; book(req): Promise<Booking>; status(id): Promise<DeliveryStatus>}
 *
 * Adapters are registered once at module load and resolved per-tenant via
 * courier_configs (same registry discipline as
 * server/services/payments/providers/registry.ts).
 *
 * ALL money is INTEGER CENTS. Distances are km; durations are minutes.
 * Adapters must be deterministic: no unseeded Math.random — derive any
 * pseudo-randomness from shared/prng.ts seeded on request fields.
 */

/** Delivery lifecycle states (superset; adapters may skip intermediates). */
export type DeliveryState =
  | "quoted"
  | "booked"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled";

export interface QuoteRequest {
  tenantId: string;
  /** Pickup coordinates — usually the merchant's branch (merchant_locations). */
  pickup?: { lat: number; lng: number; address?: string | null } | null;
  /** Dropoff coordinates when the buyer shared a pin. */
  dropoff?: { lat: number; lng: number } | null;
  /** Free-text dropoff address (WhatsApp chat orders). */
  dropoffAddress?: string | null;
  weightKg?: number;
  /** Order value in integer cents (some couriers price insurance on value). */
  orderValueCents?: number;
  currency?: string;
}

export interface Quote {
  /** Adapter id (registry key). */
  courier: string;
  /** Deterministic quote id — adapters derive it from request fields. */
  quoteId: string;
  /** Delivery fee in INTEGER CENTS. */
  feeCents: number;
  currency: string;
  distanceKm: number | null;
  etaMinutes: number;
  /** Human-readable label for the buyer, e.g. "Local moto dispatch". */
  label: string;
  expiresAt?: string | null;
}

export interface BookRequest {
  tenantId: string;
  orderId: string;
  quote: Quote;
  pickup: { name?: string | null; phone?: string | null; address?: string | null; lat?: number; lng?: number } | null;
  dropoff: { name?: string | null; phone: string; address?: string | null; lat?: number; lng?: number };
  notes?: string | null;
}

export interface Booking {
  courier: string;
  /** Courier-side dispatch/tracking id. */
  externalId: string;
  status: DeliveryState;
  /** Rider/dispatch detail safe to show the buyer (no PII beyond first name). */
  riderLabel?: string | null;
  raw?: unknown;
}

export interface DeliveryStatus {
  courier: string;
  externalId: string;
  status: DeliveryState;
  at: string; // ISO timestamp of this status
  raw?: unknown;
}

/** FROZEN CONTRACT — do not change the shape of this interface. */
export interface CourierAdapter {
  readonly id: string;
  readonly displayName: string;
  quote(req: QuoteRequest): Promise<Quote>;
  book(req: BookRequest): Promise<Booking>;
  status(externalId: string): Promise<DeliveryStatus>;
}
