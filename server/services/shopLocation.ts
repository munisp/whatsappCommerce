/**
 * shopLocation.ts — a shop's own location, from a pin its owner shares on WhatsApp.
 *
 * Saved as the shop's main merchant_locations row and made discoverable: the owner shares it so buyers nearby can
 * find the shop (the shared number's "shops near me", geo discovery). The portal's Discovery settings
 * (/settings/discovery) can change or hide it afterwards.
 */
import { desc, eq } from "drizzle-orm";
import { merchantLocations } from "../../drizzle/schema";
import { encodeGeohash } from "./geoDiscovery";

type Db = any;

export interface SharedPin {
  latitude: number;
  longitude: number;
  /** WhatsApp sends these when the pin is a named place. */
  name?: string | null;
  address?: string | null;
}

/** A WhatsApp location message's pin, or null. */
export function pinFromMessage(msg: any): SharedPin | null {
  if (msg?.type !== "location") return null;
  const latitude = Number(msg.location?.latitude);
  const longitude = Number(msg.location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 255) : null);
  return { latitude, longitude, name: text(msg.location?.name), address: text(msg.location?.address) };
}

/** Save the pin as the shop's location (updating the one it has) and make it discoverable. */
export async function saveShopPin(db: Db, tenantId: string, pin: SharedPin): Promise<{ id: string; updated: boolean }> {
  const values = {
    latitude: pin.latitude.toFixed(7),
    longitude: pin.longitude.toFixed(7),
    addressLine: pin.address ?? pin.name ?? null,
    geohash: encodeGeohash(pin.latitude, pin.longitude),
    discoverable: true,
    updatedAt: new Date(),
  };
  const [existing] = await db.select({ id: merchantLocations.id }).from(merchantLocations)
    .where(eq(merchantLocations.tenantId, tenantId)).orderBy(desc(merchantLocations.createdAt)).limit(1);
  if (existing) {
    await db.update(merchantLocations).set(values).where(eq(merchantLocations.id, existing.id));
    return { id: existing.id, updated: true };
  }
  const [row] = await db.insert(merchantLocations).values({ tenantId, label: "Main branch", ...values }).returning({ id: merchantLocations.id });
  return { id: row.id, updated: false };
}

/** Whether the shop has any location saved. */
export async function hasShopLocation(db: Db, tenantId: string): Promise<boolean> {
  const rows = await db.select({ id: merchantLocations.id }).from(merchantLocations)
    .where(eq(merchantLocations.tenantId, tenantId)).limit(1);
  return rows.length > 0;
}
