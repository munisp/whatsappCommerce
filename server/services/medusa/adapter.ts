/**
 * server/services/medusa/adapter.ts — W28 Medusa adapter layer.
 *
 * Adapter-based integration (SPEC_W28 hard invariant): all Medusa access goes
 * through the MedusaAdapter interface. The HTTP implementation is fetch-based
 * and env/DB-configured; the MockMedusaAdapter is deterministic (HMAC-derived
 * ids, no Math.random, full state for assertions) so tests and the simulation
 * never hit a live endpoint. Adapter resolution mirrors the payment-provider
 * registry pattern: getMedusaAdapter(tenantId) resolves the per-tenant store
 * mapping (medusa_store_mappings) and falls back to the env bootstrap
 * (MEDUSA_API_URL / MEDUSA_ADMIN_API_KEY) when no mapping exists.
 *
 * Determinism: set MEDUSA_ADAPTER=mock to force the shared mock (the
 * simulation world does this); tests can also import mockMedusaAdapter
 * directly to seed products / assert outbound order creation.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { medusaStoreMappings } from "../../../drizzle/schema";

// ── Types ───────────────────────────────────────────────────────────────────

export interface MedusaVariantPrice {
  currency_code: string;
  /** Integer minor units (cents) — Medusa-native. */
  amount: number;
}

export interface MedusaVariant {
  id: string;
  title: string;
  prices: MedusaVariantPrice[];
  inventory_quantity?: number;
  sku?: string;
}

export interface MedusaProduct {
  id: string;
  title: string;
  description?: string | null;
  handle?: string;
  thumbnail?: string | null;
  status?: string;
  sales_channels?: Array<{ id: string }>;
  metadata?: Record<string, unknown> | null;
  variants: MedusaVariant[];
}

export interface MedusaOrderItemInput {
  variantId: string;
  title: string;
  quantity: number;
  /** Integer minor units (cents). */
  unitPriceCents: number;
}

export interface MedusaOrderInput {
  platformOrderId: string;
  platformOrderNumber: string;
  currency: string;
  email: string;
  phone: string;
  address?: string | null;
  items: MedusaOrderItemInput[];
  /** Integer minor units (cents). */
  totalCents: number;
}

export interface MedusaOrder {
  id: string;
  status: string;
  currency_code: string;
  total: number;
  items: MedusaOrderItemInput[];
  metadata?: Record<string, unknown>;
}

export interface MedusaAdapter {
  readonly kind: "http" | "mock";
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  listProducts(opts?: { limit?: number; offset?: number }): Promise<{ products: MedusaProduct[]; count: number }>;
  createOrder(input: MedusaOrderInput): Promise<MedusaOrder>;
  getOrder(id: string): Promise<MedusaOrder | null>;
}

// ── HTTP adapter ────────────────────────────────────────────────────────────

export class HttpMedusaAdapter implements MedusaAdapter {
  readonly kind = "http" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-medusa-access-token": this.apiKey,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Medusa ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.call("/admin/products?limit=1");
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  async listProducts(opts?: { limit?: number; offset?: number }): Promise<{ products: MedusaProduct[]; count: number }> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const data = await this.call(`/admin/products?limit=${limit}&offset=${offset}`);
    return { products: (data?.products ?? []) as MedusaProduct[], count: data?.count ?? 0 };
  }

  async createOrder(input: MedusaOrderInput): Promise<MedusaOrder> {
    const payload = {
      email: input.email,
      items: input.items.map((i) => ({
        variant_id: i.variantId,
        title: i.title,
        quantity: i.quantity,
        unit_price: i.unitPriceCents,
      })),
      currency_code: input.currency.toLowerCase(),
      metadata: {
        platform_order_id: input.platformOrderId,
        platform_order_number: input.platformOrderNumber,
        whatsapp_phone: input.phone,
        shipping_address_raw: input.address ?? "",
      },
    };
    const data = await this.call("/admin/orders", { method: "POST", body: JSON.stringify(payload) });
    const o = data?.order ?? {};
    return {
      id: String(o.id ?? ""),
      status: String(o.status ?? "pending"),
      currency_code: input.currency.toLowerCase(),
      total: input.totalCents,
      items: input.items,
      metadata: payload.metadata,
    };
  }

  async getOrder(id: string): Promise<MedusaOrder | null> {
    try {
      const data = await this.call(`/admin/orders/${encodeURIComponent(id)}`);
      const o = data?.order;
      if (!o) return null;
      return {
        id: String(o.id),
        status: String(o.status ?? "pending"),
        currency_code: String(o.currency_code ?? ""),
        total: Number(o.total ?? 0),
        items: [],
        metadata: o.metadata ?? {},
      };
    } catch {
      return null;
    }
  }
}

// ── Deterministic mock adapter ──────────────────────────────────────────────

/**
 * Deterministic in-memory Medusa. Ids are HMAC-derived from stable inputs
 * (never Math.random / Date.now); the full product + order state is exposed
 * for assertions. Tests seed products via seedProducts(); the catalog-sync
 * backfill and webhook upsert paths consume exactly what was seeded.
 */
export class MockMedusaAdapter implements MedusaAdapter {
  readonly kind = "mock" as const;
  readonly products = new Map<string, MedusaProduct>();
  readonly orders = new Map<string, MedusaOrder>();
  readonly createOrderCalls: MedusaOrderInput[] = [];
  /** When set, testConnection() reports this error instead of ok. */
  scriptedConnectionError: string | null = null;

  private deriveId(prefix: string, key: string): string {
    return `${prefix}_${createHmac("sha256", "w28-medusa-mock").update(key).digest("hex").slice(0, 24)}`;
  }

  seedProducts(products: MedusaProduct[]): void {
    for (const p of products) this.products.set(p.id, p);
  }

  reset(): void {
    this.products.clear();
    this.orders.clear();
    this.createOrderCalls.length = 0;
    this.scriptedConnectionError = null;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return this.scriptedConnectionError
      ? { ok: false, error: this.scriptedConnectionError }
      : { ok: true };
  }

  async listProducts(opts?: { limit?: number; offset?: number }): Promise<{ products: MedusaProduct[]; count: number }> {
    const all = Array.from(this.products.values()).sort((a, b) => a.id.localeCompare(b.id));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return { products: all.slice(offset, offset + limit), count: all.length };
  }

  async createOrder(input: MedusaOrderInput): Promise<MedusaOrder> {
    // Idempotent per platform order — a retried bridge returns the same order.
    const existing = Array.from(this.orders.values()).find(
      (o) => o.metadata?.platform_order_id === input.platformOrderId,
    );
    if (existing) return existing;
    const order: MedusaOrder = {
      id: this.deriveId("medusa_order", input.platformOrderId),
      status: "pending",
      currency_code: input.currency.toLowerCase(),
      total: input.totalCents,
      items: input.items,
      metadata: {
        platform_order_id: input.platformOrderId,
        platform_order_number: input.platformOrderNumber,
        whatsapp_phone: input.phone,
      },
    };
    this.orders.set(order.id, order);
    this.createOrderCalls.push(input);
    return order;
  }

  async getOrder(id: string): Promise<MedusaOrder | null> {
    return this.orders.get(id) ?? null;
  }
}

/** Shared mock instance (MEDUSA_ADAPTER=mock). The simulation world sets the
 * env var before boot; journeys import this lazily to seed/assert. */
export const mockMedusaAdapter = new MockMedusaAdapter();

// ── Registry (payment-provider pattern) ─────────────────────────────────────

export interface ResolvedMedusaConnection {
  adapter: MedusaAdapter;
  mapping: typeof medusaStoreMappings.$inferSelect | null;
}

/**
 * Resolve the Medusa adapter for a tenant. Order of precedence:
 *  1. MEDUSA_ADAPTER=mock → shared deterministic mock (tests/simulation).
 *  2. Tenant mapping row (medusa_store_mappings) with a baseUrl — the API key
 *     is resolved by the caller-facing credential store (tenant_integrations);
 *     here we accept MEDUSA_ADMIN_API_KEY as the env bootstrap fallback.
 *  3. Env bootstrap MEDUSA_API_URL (+ MEDUSA_ADMIN_API_KEY), mapping = null.
 * Returns null when Medusa is not configured for the tenant at all.
 */
export async function getMedusaAdapter(tenantId: string): Promise<ResolvedMedusaConnection | null> {
  const db = await getDb();
  let mapping: typeof medusaStoreMappings.$inferSelect | null = null;
  if (db) {
    const [row] = await db
      .select()
      .from(medusaStoreMappings)
      .where(eq(medusaStoreMappings.tenantId, tenantId))
      .limit(1)
      .catch(() => []);
    mapping = row ?? null;
  }

  if (process.env.MEDUSA_ADAPTER === "mock") {
    return { adapter: mockMedusaAdapter, mapping };
  }

  const baseUrl = mapping?.baseUrl ?? process.env.MEDUSA_API_URL ?? null;
  if (!baseUrl) return null;
  // Credential resolution: the tenant_integrations row (encrypted at rest) is
  // authoritative; env is the deploy-time bootstrap. Lazy import to avoid a
  // module-load cycle with integrationSync.
  let apiKey = process.env.MEDUSA_ADMIN_API_KEY ?? "";
  try {
    const { getMedusaIntegrationConfig } = await import("../integrationSync");
    const cfg = await getMedusaIntegrationConfig(tenantId);
    if (cfg?.adminApiKey) apiKey = cfg.adminApiKey;
  } catch { /* env fallback */ }
  if (!apiKey) return null;
  return { adapter: new HttpMedusaAdapter(baseUrl, apiKey), mapping };
}

/** Convenience: read only the mapping row (null when absent). */
export async function getMedusaMapping(tenantId: string) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(medusaStoreMappings)
    .where(eq(medusaStoreMappings.tenantId, tenantId))
    .limit(1)
    .catch(() => []);
  return row ?? null;
}
