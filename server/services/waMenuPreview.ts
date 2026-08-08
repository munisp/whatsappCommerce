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

export interface WaMenuLiveData {
  businessName: string;
  /** in-stock product count (drives "Shop (N items)") */
  shopItemCount?: number;
  /** up to 5 in-stock product names shown under the shop entry */
  topProducts?: string[];
  /** count of open (not delivered/cancelled) orders */
  openOrderCount?: number;
}

const OPEN_ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped"] as const;

/** Pure renderer — no I/O. Must stay in sync with the runtime renderer. */
export function renderWaMenu(menu: WaMenuConfig, data: WaMenuLiveData): string {
  const lines: string[] = [];
  lines.push(menu.greeting.replaceAll("{businessName}", data.businessName));
  lines.push("");

  let n = 0;
  const enabled = [...menu.useCases].filter((u) => u.enabled).sort((a, b) => a.order - b.order);
  for (const uc of enabled) {
    n += 1;
    let label = uc.label;
    if (uc.id === "shop" && typeof data.shopItemCount === "number") {
      label = `${label} (${data.shopItemCount} items)`;
    }
    if (uc.id === "track" && typeof data.openOrderCount === "number") {
      label = `${label} (${data.openOrderCount} open)`;
    }
    lines.push(`${n}. ${label}`);
    if (uc.id === "shop" && data.topProducts && data.topProducts.length > 0) {
      for (const name of data.topProducts.slice(0, 5)) {
        lines.push(`   • ${name}`);
      }
    }
  }
  for (const item of menu.customItems) {
    n += 1;
    lines.push(`${n}. ${item.label}`);
  }
  return lines.join("\n");
}

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
