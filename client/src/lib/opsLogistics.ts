/**
 * Pure client-side helpers for the ops frontend (live logistics map, health,
 * audit, broadcast segment builder). No DOM / React / network dependencies —
 * covered by server/opsFrontendHelpers.test.ts (vitest, node env).
 */

// ─── Shipment status → marker/badge color ────────────────────────────────────

/** Marker colors for the live map + side list, keyed by shipment status. */
export const SHIPMENT_STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b", // amber
  created: "#f59e0b",
  label_created: "#f59e0b",
  picked_up: "#3b82f6", // blue
  in_transit: "#8b5cf6", // violet
  out_for_delivery: "#06b6d4", // cyan
  delivered: "#10b981", // emerald
  failed: "#ef4444", // red
  returned: "#6b7280", // gray
  cancelled: "#6b7280",
};

export const DEFAULT_STATUS_COLOR = "#94a3b8"; // slate for unknown statuses

export function shipmentStatusColor(status: string | null | undefined): string {
  if (!status) return DEFAULT_STATUS_COLOR;
  return SHIPMENT_STATUS_COLORS[status.toLowerCase()] ?? DEFAULT_STATUS_COLOR;
}

/** Statuses that mean the shipment no longer needs ops attention. */
export const TERMINAL_SHIPMENT_STATUSES = new Set(["delivered", "failed", "returned", "cancelled"]);

export function isActiveShipment(status: string | null | undefined): boolean {
  return !TERMINAL_SHIPMENT_STATUSES.has((status ?? "").toLowerCase());
}

// ─── Coordinate extraction ───────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function validLatLng(lat: number | null, lng: number | null): LatLng | null {
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Pull coordinates out of one jsonb blob (address / metadata). Accepts the
 * common shapes carriers and tenants actually store:
 *   { lat, lng } | { latitude, longitude } | { lat, lon }
 *   { coordinates: [lng, lat] }            (GeoJSON order)
 *   { geo: { ... } } / { location: { ... } } (nested one level)
 */
export function extractCoordsFromBlob(blob: unknown): LatLng | null {
  if (!blob || typeof blob !== "object") return null;
  const o = blob as Record<string, unknown>;

  const direct = validLatLng(
    asFiniteNumber(o.lat ?? o.latitude),
    asFiniteNumber(o.lng ?? o.lon ?? o.longitude),
  );
  if (direct) return direct;

  if (Array.isArray(o.coordinates) && o.coordinates.length >= 2) {
    // GeoJSON: [lng, lat]
    const c = validLatLng(asFiniteNumber(o.coordinates[1]), asFiniteNumber(o.coordinates[0]));
    if (c) return c;
  }

  for (const key of ["geo", "location", "coords", "position"]) {
    const nested = extractCoordsFromBlob(o[key]);
    if (nested) return nested;
  }
  return null;
}

/**
 * Best-effort coordinates for a shipment row. Recipient address wins (that is
 * where the parcel is heading), then metadata, then the sender address.
 */
export function extractShipmentCoords(shipment: {
  recipientAddress?: unknown;
  senderAddress?: unknown;
  metadata?: unknown;
}): LatLng | null {
  return (
    extractCoordsFromBlob(shipment.recipientAddress) ??
    extractCoordsFromBlob(shipment.metadata) ??
    extractCoordsFromBlob(shipment.senderAddress)
  );
}

// ─── ETA mirror (client-side copy of server/services/eta.ts) ─────────────────
// The list API does not carry per-shipment ETAs, so the map mirrors the
// server engine's coarse math: zone base ETA × status fraction, rounded to 5.

export const ETA_DEFAULT_SAME_CITY = 45;
export const ETA_DEFAULT_INTERCITY = 180;

/** Fraction of the base ETA remaining at each status (mirror of server). */
export const ETA_STATUS_FRACTION: Record<string, number> = {
  pending: 1,
  created: 1,
  picked_up: 0.6,
  in_transit: 0.45,
  out_for_delivery: 0.3,
  delivered: 0,
  failed: 0,
  returned: 0,
};

export interface EtaZone {
  name: string;
  etaMinutes?: number;
}

function roundTo5(n: number): number {
  return Math.max(5, Math.round(n / 5) * 5);
}

/**
 * Remaining ETA in minutes for a shipment. Returns 0 for terminal statuses.
 * `zones` are the tenant's settings.commerce.deliveryZones (may carry
 * etaMinutes); `zoneName` matches case-insensitively by trimmed name.
 */
export function estimateEtaMinutes(input: {
  status?: string | null;
  zoneName?: string | null;
  zones?: EtaZone[] | null;
  sameCity?: boolean | null;
}): number {
  const fraction = ETA_STATUS_FRACTION[(input.status ?? "").toLowerCase()] ?? 1;
  if (fraction <= 0) return 0;

  const zones = input.zones ?? [];
  let base: number | null = null;
  if (input.zoneName) {
    const wanted = input.zoneName.trim().toLowerCase();
    const match = zones.find((z) => z.name?.trim().toLowerCase() === wanted);
    if (match && Number.isFinite(match.etaMinutes) && (match.etaMinutes as number) > 0) {
      base = Number(match.etaMinutes);
    }
  }
  if (base == null) {
    base = input.sameCity === false ? ETA_DEFAULT_INTERCITY : ETA_DEFAULT_SAME_CITY;
  }
  return roundTo5(base * fraction);
}

/** Human label: null hides the ETA line (terminal shipments). */
export function formatEta(etaMinutes: number | null | undefined): string | null {
  if (!etaMinutes || etaMinutes <= 0) return null;
  if (etaMinutes >= 120) {
    const h = Math.floor(etaMinutes / 60);
    const m = etaMinutes % 60;
    return m ? `~${h}h ${m}m` : `~${h}h`;
  }
  return `~${etaMinutes} min`;
}

// ─── Delivery PIN masking ────────────────────────────────────────────────────

/** Never render a buyer handover PIN in the ops UI — mask to fixed bullets. */
export function maskDeliveryPin(pin: string | null | undefined): string | null {
  if (!pin) return null;
  return "•".repeat(Math.max(4, pin.length));
}

// ─── ₦ → kobo conversion (broadcast segment builder) ─────────────────────────

/**
 * Convert a naira amount (major units, may be a string from an input) into
 * integer kobo (minor units). Returns null for empty/invalid/negative input
 * so callers can treat "field left blank" as "no filter".
 */
export function nairaToKobo(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "string" ? Number(value.replace(/[,\s₦]/g, "")) : value;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export interface SegmentFilterInput {
  tags?: string[];
  minOrders?: number;
  minSpendKobo?: number;
  lastOrderWithinDays?: number;
}

/**
 * Build the broadcast.send segment payload from raw form state. Empty fields
 * are omitted; returns undefined when nothing is set (send to full audience).
 */
export function buildSegmentFilter(raw: {
  tagsText?: string;
  minOrders?: string | number;
  minSpendNaira?: string | number;
  lastOrderWithinDays?: string | number;
}): SegmentFilterInput | undefined {
  const out: SegmentFilterInput = {};

  const tags = (raw.tagsText ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tags.length > 0) out.tags = tags.slice(0, 50);

  const minOrders = raw.minOrders === "" || raw.minOrders == null ? null : Number(raw.minOrders);
  if (minOrders != null && Number.isFinite(minOrders) && minOrders >= 1) {
    out.minOrders = Math.floor(minOrders);
  }

  const kobo = nairaToKobo(raw.minSpendNaira ?? null);
  if (kobo != null && kobo > 0) out.minSpendKobo = kobo;

  const days =
    raw.lastOrderWithinDays === "" || raw.lastOrderWithinDays == null
      ? null
      : Number(raw.lastOrderWithinDays);
  if (days != null && Number.isFinite(days) && days >= 1) {
    out.lastOrderWithinDays = Math.min(3650, Math.floor(days));
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
