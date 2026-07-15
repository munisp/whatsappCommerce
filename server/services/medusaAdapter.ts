/**
 * MedusaCommerceAdapter
 * Wraps Medusa v2 Store + Admin REST API.
 * When MEDUSA_API_URL is set, all calls go to the Medusa instance.
 * When not configured, falls back to the native Drizzle tables so the
 * platform works out-of-the-box without a separate Medusa server.
 */

const MEDUSA_URL = process.env.MEDUSA_API_URL ?? "";
const MEDUSA_ADMIN_KEY = process.env.MEDUSA_ADMIN_API_KEY ?? "";
const MEDUSA_PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? "";

export const isMedusaConfigured = () => !!MEDUSA_URL;

async function medusaFetch<T>(
  path: string,
  options: RequestInit = {},
  isAdmin = false
): Promise<T> {
  const base = MEDUSA_URL.replace(/\/$/, "");
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (isAdmin) {
    headers["x-medusa-access-token"] = MEDUSA_ADMIN_KEY;
  } else {
    headers["x-publishable-api-key"] = MEDUSA_PUBLISHABLE_KEY;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Medusa API ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Store API ─────────────────────────────────────────────────────────────────

export interface MedusaProduct {
  id: string;
  title: string;
  description?: string;
  status: string;
  thumbnail?: string;
  variants: Array<{
    id: string;
    title: string;
    sku?: string;
    prices: Array<{ amount: number; currency_code: string }>;
    inventory_quantity?: number;
  }>;
  collection?: { id: string; title: string };
  categories?: Array<{ id: string; name: string }>;
}

export async function listProducts(params?: {
  limit?: number;
  offset?: number;
  collection_id?: string[];
  category_id?: string[];
  q?: string;
}): Promise<{ products: MedusaProduct[]; count: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  if (params?.q) qs.set("q", params.q);
  params?.collection_id?.forEach(id => qs.append("collection_id[]", id));
  params?.category_id?.forEach(id => qs.append("category_id[]", id));
  const query = qs.toString() ? `?${qs}` : "";
  return medusaFetch(`/store/products${query}`);
}

export async function getProduct(id: string): Promise<{ product: MedusaProduct }> {
  return medusaFetch(`/store/products/${id}`);
}

export async function listCollections(): Promise<{ collections: Array<{ id: string; title: string; handle: string }> }> {
  return medusaFetch("/store/collections");
}

export async function listCategories(): Promise<{ product_categories: Array<{ id: string; name: string; handle: string }> }> {
  return medusaFetch("/store/product-categories");
}

// ── Cart API ──────────────────────────────────────────────────────────────────

export interface MedusaCart {
  id: string;
  items: Array<{
    id: string;
    title: string;
    quantity: number;
    unit_price: number;
    variant_id: string;
  }>;
  total: number;
  currency_code: string;
  region_id: string;
}

export async function createCart(regionId: string): Promise<{ cart: MedusaCart }> {
  return medusaFetch("/store/carts", {
    method: "POST",
    body: JSON.stringify({ region_id: regionId }),
  });
}

export async function addToCart(cartId: string, variantId: string, quantity: number): Promise<{ cart: MedusaCart }> {
  return medusaFetch(`/store/carts/${cartId}/line-items`, {
    method: "POST",
    body: JSON.stringify({ variant_id: variantId, quantity }),
  });
}

export async function getCart(cartId: string): Promise<{ cart: MedusaCart }> {
  return medusaFetch(`/store/carts/${cartId}`);
}

// ── Order API ─────────────────────────────────────────────────────────────────

export interface MedusaOrder {
  id: string;
  display_id: number;
  status: string;
  total: number;
  currency_code: string;
  items: Array<{ id: string; title: string; quantity: number; unit_price: number }>;
  shipping_address?: { address_1?: string; city?: string; country_code?: string };
  payment_status: string;
  fulfillment_status: string;
  created_at: string;
}

export async function listOrders(params?: { limit?: number; offset?: number; customer_id?: string }): Promise<{ orders: MedusaOrder[]; count: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  if (params?.customer_id) qs.set("customer_id", params.customer_id);
  const query = qs.toString() ? `?${qs}` : "";
  return medusaFetch(`/admin/orders${query}`, {}, true);
}

export async function getOrder(id: string): Promise<{ order: MedusaOrder }> {
  return medusaFetch(`/admin/orders/${id}`, {}, true);
}

// ── Admin: Price Lists (B2B wholesale) ───────────────────────────────────────

export interface MedusaPriceList {
  id: string;
  name: string;
  type: "sale" | "override";
  status: "active" | "draft";
  customer_groups?: Array<{ id: string; name: string }>;
  prices: Array<{ variant_id: string; amount: number; currency_code: string; min_quantity?: number }>;
}

export async function listPriceLists(): Promise<{ price_lists: MedusaPriceList[] }> {
  return medusaFetch("/admin/price-lists", {}, true);
}

export async function createPriceList(data: {
  name: string;
  type: "sale" | "override";
  prices: Array<{ variant_id: string; amount: number; currency_code: string; min_quantity?: number }>;
}): Promise<{ price_list: MedusaPriceList }> {
  return medusaFetch("/admin/price-lists", {
    method: "POST",
    body: JSON.stringify({ ...data, status: "active" }),
  }, true);
}

// ── Admin: Inventory ──────────────────────────────────────────────────────────

export async function getInventoryItem(variantId: string): Promise<{ inventory_items: Array<{ id: string; sku?: string; stocked_quantity: number }> }> {
  return medusaFetch(`/admin/inventory-items?variant_id=${variantId}`, {}, true);
}

// ── Admin: Promotions / Discounts ─────────────────────────────────────────────

export async function listPromotions(): Promise<{ promotions: Array<{ id: string; code: string; type: string; is_disabled: boolean }> }> {
  return medusaFetch("/admin/promotions", {}, true);
}

// ── Regions (multi-currency) ──────────────────────────────────────────────────

export async function listRegions(): Promise<{ regions: Array<{ id: string; name: string; currency_code: string; countries: Array<{ iso_2: string; display_name: string }> }> }> {
  return medusaFetch("/store/regions");
}
