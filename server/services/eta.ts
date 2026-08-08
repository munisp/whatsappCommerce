/**
 * Delivery ETA engine.
 *
 * Base ETA comes from the tenant's configured delivery zones
 * (settings.commerce.deliveryZones[].etaMinutes — optional; matched by zone
 * name) falling back to sane Nigerian commerce defaults: 45 min same-city,
 * 180 min intercity. The base is then scaled by a shipment-status offset —
 * as a shipment progresses, less of the journey remains:
 *
 *   pending/created      → 100% of base
 *   picked_up            → 60% of base
 *   in_transit           → 45% of base
 *   out_for_delivery     → 30% of base
 *   delivered/failed/returned → 0 (no ETA)
 *
 * The estimate is deliberately coarse (whole minutes, rounded to 5) — honest
 * precision, no fake exactness.
 */

export const DEFAULT_ETA_SAME_CITY_MINUTES = 45;
export const DEFAULT_ETA_INTERCITY_MINUTES = 180;

/** Fraction of the zone base ETA still remaining at each shipment status. */
export const STATUS_ETA_FRACTION: Record<string, number> = {
  pending: 1,
  created: 1,
  picked_up: 0.6,
  in_transit: 0.45,
  out_for_delivery: 0.3,
  delivered: 0,
  failed: 0,
  returned: 0,
};

export interface EtaZoneConfig {
  name: string;
  etaMinutes?: number;
}

export interface EstimateDeliveryInput {
  /** Current shipment status (null/unknown → full base ETA). */
  status?: string | null;
  /** Named delivery zone (matched against tenant-configured zones). */
  zoneName?: string | null;
  /** Tenant-configured zones (settings.commerce.deliveryZones). */
  zones?: EtaZoneConfig[] | null;
  /** Same-city delivery? Used for the default base when no zone matches. */
  sameCity?: boolean | null;
}

function roundTo5(n: number): number {
  return Math.max(5, Math.round(n / 5) * 5);
}

/** Base (pre-offset) ETA for a zone, with defaults. */
export function zoneBaseEtaMinutes(input: EstimateDeliveryInput): number {
  const zones = input.zones ?? [];
  if (input.zoneName) {
    const wanted = input.zoneName.trim().toLowerCase();
    const match = zones.find(z => z.name?.trim().toLowerCase() === wanted);
    if (match && Number.isFinite(match.etaMinutes) && (match.etaMinutes as number) > 0) {
      return Number(match.etaMinutes);
    }
  }
  // No zone match: any configured zone ETA is better than nothing only when
  // it is unambiguous; otherwise fall back to the same-city/intercity default.
  return input.sameCity === false ? DEFAULT_ETA_INTERCITY_MINUTES : DEFAULT_ETA_SAME_CITY_MINUTES;
}

/**
 * Estimate the remaining delivery time in minutes for a shipment.
 * Returns 0 for terminal statuses (delivered/failed/returned).
 */
export function estimateDelivery(input: EstimateDeliveryInput): number {
  const status = (input.status ?? "").toLowerCase();
  const fraction = STATUS_ETA_FRACTION[status] ?? 1;
  if (fraction <= 0) return 0;
  return roundTo5(zoneBaseEtaMinutes(input) * fraction);
}

/** Format the ETA line injected into buyer-facing WhatsApp messages. */
export function formatEtaLine(etaMinutes: number): string | null {
  if (!etaMinutes || etaMinutes <= 0) return null;
  return `⏱ ETA ~${etaMinutes} min`;
}

// ── DB-backed shipment ETA (used by logistics notifications + tracking) ──────

import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import { logisticsShipments, tenants } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Remaining ETA (minutes) for a stored shipment: tenant zone ETAs +
 * status offset. Same-city is inferred from the sender/recipient cities when
 * both are present. Never throws — ETA is a convenience, not a gate.
 */
export async function estimateShipmentRemainingEta(
  db: Db,
  opts: { shipmentId: string; status: string; tenantId: string },
): Promise<number> {
  try {
    const [shipment] = await db.select().from(logisticsShipments)
      .where(eq(logisticsShipments.id, opts.shipmentId)).limit(1).catch(() => []);
    const [tenant] = await db.select({ settings: tenants.settings }).from(tenants)
      .where(eq(tenants.id, opts.tenantId)).limit(1).catch(() => []);
    const zones = (((tenant?.settings as any)?.commerce?.deliveryZones) ?? []) as EtaZoneConfig[];
    const senderCity = ((shipment?.senderAddress as any)?.city ?? "").trim().toLowerCase();
    const recipientCity = ((shipment?.recipientAddress as any)?.city ?? "").trim().toLowerCase();
    const sameCity = senderCity && recipientCity ? senderCity === recipientCity : null;
    return estimateDelivery({ status: opts.status, zones, sameCity });
  } catch (err: any) {
    console.warn("[eta] estimateShipmentRemainingEta failed:", err?.message);
    return estimateDelivery({ status: opts.status });
  }
}
