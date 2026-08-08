/**
 * server/services/waMenuPreview.ts — pure WhatsApp menu renderer + preview.
 *
 * renderWaMenu() is a pure function over (WaMenuConfig, live data) so the
 * runtime renderer agent's output matches this exact shape:
 *
 *   greeting + numbered list of enabled useCases (sorted by order)
 *   + numbered customItems.
 *
 * Live-data enrichments used by the admin preview:
 *   - shop label gets a " (N items)" suffix from in-stock product count,
 *     followed by up to 5 top in-stock product names as sub-lines;
 *   - track label gets a " (N open)" suffix from the open-order count.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { orders, products, tenants } from "../../drizzle/schema";
import type { WaMenuConfig } from "../../shared/waMenu";
import { isWaMenuConfig } from "../../shared/waMenu";
import type { TenantSettings } from "../../shared/tenantConfig";

// The pure renderer + live-data shape live in shared/waMenu.ts so the admin
// menu builder can render draft previews with the exact same rules.
export { renderWaMenu, type WaMenuLiveData } from "../../shared/waMenu";
import { renderWaMenu, type WaMenuLiveData } from "../../shared/waMenu";

const OPEN_ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped"] as const;

/** Gather live preview data (product + order counts) for a tenant. */
export async function gatherWaMenuLiveData(tenantId: string): Promise<WaMenuLiveData> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const [tenant] = await db
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  const settings = (tenant.settings ?? {}) as TenantSettings;
  const businessName =
    (settings.branding?.name as string | undefined) || tenant.name || "our store";

  const inStock = await db
    .select({ name: products.name })
    .from(products)
    .where(
      and(
        eq(products.tenantId, tenantId),
        eq(products.status, "active"),
        gt(products.stockQuantity, 0),
      ),
    )
    .orderBy(products.name)
    .limit(100);

  const openOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        inArray(orders.status, [...OPEN_ORDER_STATUSES]),
      ),
    );

  return {
    businessName,
    shopItemCount: inStock.length,
    topProducts: inStock.slice(0, 5).map((p) => p.name),
    openOrderCount: openOrders.length,
  };
}

/** Full preview: fetch config + live data, render menu text. */
export async function previewWaMenuForTenant(
  tenantId: string,
): Promise<{ text: string; menu: WaMenuConfig; data: WaMenuLiveData }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  const raw = ((tenant.settings ?? {}) as TenantSettings).waMenu;
  if (!isWaMenuConfig(raw)) throw new Error("Tenant has no valid waMenu config");
  const data = await gatherWaMenuLiveData(tenantId);
  return { text: renderWaMenu(raw, data), menu: raw, data };
}
