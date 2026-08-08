/**
 * Low-stock admin alerts.
 *
 * Triggered from the inventory reserve/commit paths (post-transaction,
 * fire-and-forget — errors are logged, never thrown): when a product's
 * remaining stockQuantity is at/below the tenant threshold
 * (settings.inventory.lowStockThreshold, falling back to the product's own
 * lowStockThreshold), a WhatsApp alert goes to settings.adminPhone naming the
 * product and remaining units.
 *
 * Dedupe: at most one alert per (tenant, product) per 6h — Redis key
 * lowstock:{tenant}:{product} when Redis is configured, with an in-process
 * Map fallback so a Redis outage never spams the admin.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { products, tenants } from "../../drizzle/schema";
import { redisGet, redisSet } from "../redis";
import { sendWhatsAppText } from "./waSender";

export const LOW_STOCK_DEDUPE_TTL_SECONDS = 6 * 60 * 60; // 6h
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

/** In-process fallback dedupe (key → expiry epoch ms) when Redis is absent. */
const memoryDedupe = new Map<string, number>();

/** Test hook: clear the in-process dedupe window. */
export function resetLowStockDedupeForTests(): void {
  memoryDedupe.clear();
}

async function claimDedupeSlot(key: string): Promise<boolean> {
  try {
    const existing = await redisGet(key);
    if (existing) return false;
    await redisSet(key, "1", LOW_STOCK_DEDUPE_TTL_SECONDS);
    return true;
  } catch {
    // Redis error → fall through to in-process dedupe.
  }
  const now = Date.now();
  const expiry = memoryDedupe.get(key);
  if (expiry && expiry > now) return false;
  memoryDedupe.set(key, now + LOW_STOCK_DEDUPE_TTL_SECONDS * 1000);
  return true;
}

/**
 * Check a product's CURRENT committed stock and alert the tenant admin when
 * at/below threshold. Re-reads the row so alerts reflect committed state (a
 * rolled-back reservation leaves stock untouched and no alert fires).
 * Never throws.
 */
export async function maybeSendLowStockAlert(tenantId: string, productId: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const [product] = await db
      .select({
        id: products.id,
        name: products.name,
        stockQuantity: products.stockQuantity,
        lowStockThreshold: products.lowStockThreshold,
      })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!product) return;

    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
    const inventoryCfg = (settings.inventory ?? {}) as Record<string, unknown>;
    const threshold =
      typeof inventoryCfg.lowStockThreshold === "number" && Number.isFinite(inventoryCfg.lowStockThreshold)
        ? inventoryCfg.lowStockThreshold
        : (product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
    if (product.stockQuantity > threshold) return;

    const adminPhone = typeof settings.adminPhone === "string" ? settings.adminPhone : "";
    if (!adminPhone) return;

    const claimed = await claimDedupeSlot(`lowstock:${tenantId}:${productId}`);
    if (!claimed) return;

    await sendWhatsAppText(
      tenantId,
      adminPhone,
      `⚠️ *Low stock alert*: *${product.name}* is down to ${product.stockQuantity} unit${product.stockQuantity === 1 ? "" : "s"} left (threshold ${threshold}). Restock soon to avoid losing sales.`,
      { notifType: "low_stock_alert" },
    );
  } catch (e: unknown) {
    console.error(`[low-stock] alert failed for product ${productId}:`, (e as Error)?.message);
  }
}

/**
 * Fire-and-forget scheduling from inside the inventory reservation paths:
 * defers past the caller's transaction (the alert re-reads committed state)
 * and swallows all errors.
 */
export function scheduleLowStockCheck(tenantId: string, productId: string): void {
  setImmediate(() => {
    void maybeSendLowStockAlert(tenantId, productId).catch((e: unknown) =>
      console.error("[low-stock] scheduled check failed:", (e as Error)?.message),
    );
  });
}
