/**
 * server/services/integrations/clients.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Typed REST clients for the three external systems synced through the
 * transactional outbox:
 *
 *   - Medusa v2   → Admin REST API (products, draft orders)
 *   - Twenty CRM  → REST API (people upsert by email/phone, companies)
 *   - Odoo ERP    → JSON-RPC 2.0 `/jsonrpc` (res.partner, sale.order, stock)
 *
 * Per-tenant credentials are resolved from `tenants.settings` under
 * `settings.integrations.{medusa,twenty,odoo}`:
 *   { url, apiKey, enabled, webhookSecret, ...extras }
 * Odoo additionally accepts `database` and `username` extras (JSON-RPC auth).
 *
 * All clients share: 10s timeout, exponential-backoff retry (3 retries,
 * network/5xx/429 only), and throw a typed IntegrationError on any terminal
 * non-2xx response.
 */

import { eq } from "drizzle-orm";
import { tenants } from "../../../drizzle/schema";

// ── Types ────────────────────────────────────────────────────────────────────

export type IntegrationSystem = "medusa" | "twenty" | "odoo";
export const INTEGRATION_SYSTEMS: IntegrationSystem[] = ["medusa", "twenty", "odoo"];

export interface IntegrationConfig {
  url: string;
  apiKey?: string;
  enabled?: boolean;
  webhookSecret?: string;
  /** Odoo extras */
  database?: string;
  username?: string;
  [key: string]: unknown;
}

/** Terminal delivery failure thrown by every integration client. */
export class IntegrationError extends Error {
  readonly system: IntegrationSystem;
  readonly status: number | null;
  /** retriable=false → dispatcher marks the event 'failed' (no more retries). */
  readonly retriable: boolean;

  constructor(
    system: IntegrationSystem,
    message: string,
    opts: { status?: number | null; retriable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "IntegrationError";
    this.system = system;
    this.status = opts.status ?? null;
    this.retriable = opts.retriable ?? false;
  }
}

export interface RequestOptions {
  retries?: number; // default 3
  timeoutMs?: number; // default 10_000
  baseDelayMs?: number; // default 300 (exponential: base * 2^attempt)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch JSON with exponential backoff. Retries on network errors, 5xx and 429;
 * other 4xx are terminal. Throws IntegrationError on any terminal failure —
 * never silently swallows a non-2xx.
 */
export async function requestJson<T = unknown>(
  system: IntegrationSystem,
  url: string,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  let lastErr: IntegrationError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        return (await res.json().catch(() => ({}))) as T;
      }
      const body = await res.text().catch(() => "");
      const retriable = res.status >= 500 || res.status === 429;
      lastErr = new IntegrationError(system, `HTTP ${res.status}: ${body.slice(0, 300)}`, {
        status: res.status,
        retriable,
      });
      if (!retriable) throw lastErr; // 4xx (non-429) is deterministic — fail fast.
    } catch (err: any) {
      if (err instanceof IntegrationError) {
        lastErr = err;
        if (!err.retriable) throw err;
      } else {
        // Network error / timeout — retriable.
        lastErr = new IntegrationError(system, err?.message ?? "network error", {
          status: null,
          retriable: true,
          cause: err,
        });
      }
    }
  }
  throw lastErr ?? new IntegrationError(system, "request failed", { retriable: true });
}

// ── Per-tenant credential resolution ─────────────────────────────────────────

/** Minimal DB surface needed to resolve tenant integration config. */
export interface TenantConfigDb {
  select(cols?: unknown): {
    from(table: unknown): {
      where(cond: unknown): { limit(n: number): Promise<Array<{ settings: unknown }>> };
    };
  };
}

/**
 * Resolve per-tenant integration config from tenants.settings.integrations.
 * Throws IntegrationError (non-retriable) when the integration is missing or
 * disabled — a disabled integration must never be called.
 */
export async function resolveIntegrationConfig(
  db: TenantConfigDb,
  tenantId: string,
  system: IntegrationSystem,
): Promise<IntegrationConfig> {
  const rows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const settings = (rows[0]?.settings ?? {}) as Record<string, any>;
  const cfg = settings?.integrations?.[system] as IntegrationConfig | undefined;
  if (!cfg || typeof cfg.url !== "string" || !cfg.url) {
    throw new IntegrationError(system, `integration '${system}' is not configured for tenant ${tenantId}`, {
      retriable: false,
    });
  }
  if (cfg.enabled === false) {
    throw new IntegrationError(system, `integration '${system}' is disabled for tenant ${tenantId}`, {
      retriable: false,
    });
  }
  return { ...cfg, url: cfg.url.replace(/\/+$/, "") };
}

// ── Medusa v2 Admin REST ─────────────────────────────────────────────────────

export interface MedusaProductInput {
  externalId?: string | null; // existing Medusa product id (update path)
  title: string;
  sku: string;
  price: number; // major units
  currency: string;
  description?: string | null;
  stockQuantity?: number;
}

export interface MedusaOrderInput {
  email?: string | null;
  currency: string;
  items: Array<{ title: string; quantity: number; unitPrice: number }>;
  metadata?: Record<string, unknown>;
}

export class MedusaClient {
  protected readonly config: IntegrationConfig;
  constructor(config: IntegrationConfig) {
    this.config = { ...config, url: config.url.replace(/\/+$/, "") };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  /** GET /admin/products?limit=1 — cheap liveness + auth probe. */
  async testConnection(opts?: RequestOptions): Promise<{ ok: true }> {
    await requestJson("medusa", `${this.config.url}/admin/products?limit=1`, { headers: this.headers() }, opts);
    return { ok: true };
  }

  /** Create (or update when externalId is known) a Medusa admin product. */
  async upsertProduct(p: MedusaProductInput, opts?: RequestOptions): Promise<{ id: string }> {
    if (p.externalId) {
      const res = await requestJson<{ product: { id: string } }>(
        "medusa",
        `${this.config.url}/admin/products/${encodeURIComponent(p.externalId)}`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            title: p.title,
            description: p.description ?? undefined,
            variants: [{ sku: p.sku, prices: [{ amount: p.price, currency_code: p.currency.toLowerCase() }] }],
          }),
        },
        opts,
      );
      return { id: res.product?.id ?? p.externalId };
    }
    const res = await requestJson<{ product: { id: string } }>(
      "medusa",
      `${this.config.url}/admin/products`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          title: p.title,
          description: p.description ?? undefined,
          status: "published",
          variants: [
            {
              title: p.title,
              sku: p.sku,
              manage_inventory: true,
              prices: [{ amount: p.price, currency_code: p.currency.toLowerCase() }],
            },
          ],
        }),
      },
      opts,
    );
    return { id: res.product.id };
  }

  /**
   * Record a platform order in Medusa. Admin order creation is not supported
   * by Medusa v2, so this creates a draft order (the supported admin path).
   */
  async createDraftOrder(o: MedusaOrderInput, opts?: RequestOptions): Promise<{ id: string }> {
    const res = await requestJson<{ draft_order: { id: string } }>(
      "medusa",
      `${this.config.url}/admin/draft-orders`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          email: o.email ?? undefined,
          currency_code: o.currency.toLowerCase(),
          items: o.items.map((i) => ({
            title: i.title,
            quantity: i.quantity,
            unit_price: i.unitPrice,
          })),
          metadata: o.metadata ?? {},
        }),
      },
      opts,
    );
    return { id: res.draft_order.id };
  }
}

// ── Twenty CRM REST ──────────────────────────────────────────────────────────

export interface TwentyPersonInput {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface TwentyCompanyInput {
  name: string;
  domainName?: string | null;
}

export class TwentyClient {
  protected readonly config: IntegrationConfig;
  constructor(config: IntegrationConfig) {
    this.config = { ...config, url: config.url.replace(/\/+$/, "") };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async testConnection(opts?: RequestOptions): Promise<{ ok: true }> {
    await requestJson("twenty", `${this.config.url}/rest/people?limit=1`, { headers: this.headers() }, opts);
    return { ok: true };
  }

  private async findPerson(filterField: string, value: string, opts?: RequestOptions): Promise<{ id: string } | null> {
    const filter = encodeURIComponent(`${filterField}[eq]:${value}`);
    const res = await requestJson<{ data?: Array<{ id: string }> }>(
      "twenty",
      `${this.config.url}/rest/people?filter=${filter}&limit=1`,
      { headers: this.headers() },
      opts,
    );
    const hit = res.data?.[0];
    return hit ? { id: hit.id } : null;
  }

  /** Upsert a Twenty person, matched by primary email first, then phone. */
  async upsertPerson(p: TwentyPersonInput, opts?: RequestOptions): Promise<{ id: string }> {
    const body = {
      name: { firstName: p.firstName ?? "", lastName: p.lastName ?? "" },
      emails: p.email ? { primaryEmail: p.email } : undefined,
      phones: p.phone
        ? { primaryPhoneNumber: p.phone, primaryPhoneCountryCode: "", primaryPhoneCallingCode: "" }
        : undefined,
    };
    let existing: { id: string } | null = null;
    if (p.email) existing = await this.findPerson("emails.primaryEmail", p.email, opts);
    if (!existing && p.phone) existing = await this.findPerson("phones.primaryPhoneNumber", p.phone, opts);

    if (existing) {
      await requestJson(
        "twenty",
        `${this.config.url}/rest/people/${encodeURIComponent(existing.id)}`,
        { method: "PATCH", headers: this.headers(), body: JSON.stringify(body) },
        opts,
      );
      return { id: existing.id };
    }
    const res = await requestJson<{ data?: { id: string } }>(
      "twenty",
      `${this.config.url}/rest/people`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      opts,
    );
    return { id: res.data?.id ?? "" };
  }

  /** Upsert a Twenty company, matched by exact name. */
  async upsertCompany(c: TwentyCompanyInput, opts?: RequestOptions): Promise<{ id: string }> {
    const filter = encodeURIComponent(`name[eq]:${c.name}`);
    const found = await requestJson<{ data?: Array<{ id: string }> }>(
      "twenty",
      `${this.config.url}/rest/companies?filter=${filter}&limit=1`,
      { headers: this.headers() },
      opts,
    );
    const existing = found.data?.[0];
    const body = {
      name: c.name,
      domainName: c.domainName ? { primaryLinkUrl: c.domainName } : undefined,
    };
    if (existing) {
      await requestJson(
        "twenty",
        `${this.config.url}/rest/companies/${encodeURIComponent(existing.id)}`,
        { method: "PATCH", headers: this.headers(), body: JSON.stringify(body) },
        opts,
      );
      return { id: existing.id };
    }
    const res = await requestJson<{ data?: { id: string } }>(
      "twenty",
      `${this.config.url}/rest/companies`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      opts,
    );
    return { id: res.data?.id ?? "" };
  }
}

// ── Odoo ERP (JSON-RPC 2.0 over /jsonrpc — the version-stable endpoint) ─────

export interface OdooPartnerInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  externalRef?: string | null;
}

export interface OdooSaleOrderInput {
  partnerId: number;
  origin?: string;
  lines: Array<{ productId?: number | null; name: string; quantity: number; unitPrice: number }>;
}

export class OdooClient {
  private uid: number | null = null;

  protected readonly config: IntegrationConfig;
  constructor(config: IntegrationConfig) {
    this.config = { ...config, url: config.url.replace(/\/+$/, "") };
  }

  private get database(): string {
    const db = this.config.database;
    if (typeof db !== "string" || !db) {
      throw new IntegrationError("odoo", "odoo integration requires settings.integrations.odoo.database", {
        retriable: false,
      });
    }
    return db;
  }

  private get username(): string {
    const u = this.config.username;
    if (typeof u !== "string" || !u) {
      throw new IntegrationError("odoo", "odoo integration requires settings.integrations.odoo.username", {
        retriable: false,
      });
    }
    return u;
  }

  private get apiKey(): string {
    if (!this.config.apiKey) {
      throw new IntegrationError("odoo", "odoo integration requires settings.integrations.odoo.apiKey", {
        retriable: false,
      });
    }
    return this.config.apiKey;
  }

  /** Raw JSON-RPC 2.0 call; throws IntegrationError on transport or RPC error. */
  private async rpc<T = unknown>(
    service: string,
    method: string,
    args: unknown[],
    opts?: RequestOptions,
  ): Promise<T> {
    const res = await requestJson<{ result?: T; error?: { message?: string; data?: { message?: string } } }>(
      "odoo",
      `${this.config.url}/jsonrpc`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          id: Date.now(),
          params: { service, method, args },
        }),
      },
      opts,
    );
    if (res.error) {
      const msg = res.error.data?.message ?? res.error.message ?? "odoo rpc error";
      throw new IntegrationError("odoo", msg, { retriable: false });
    }
    return res.result as T;
  }

  /** Authenticate and cache the uid for this client instance. */
  async authenticate(opts?: RequestOptions): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc<number | false>(
      "common",
      "authenticate",
      [this.database, this.username, this.apiKey, {}],
      opts,
    );
    if (!uid) {
      throw new IntegrationError("odoo", "odoo authentication failed (check database/username/apiKey)", {
        retriable: false,
      });
    }
    this.uid = uid;
    return uid;
  }

  private async executeKw<T = unknown>(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
    opts?: RequestOptions,
  ): Promise<T> {
    const uid = await this.authenticate(opts);
    return this.rpc<T>("object", "execute_kw", [this.database, uid, this.apiKey, model, method, args, kwargs], opts);
  }

  async testConnection(opts?: RequestOptions): Promise<{ ok: true; uid: number }> {
    const uid = await this.authenticate(opts);
    return { ok: true, uid };
  }

  /** Upsert res.partner matched by email, then phone, then external ref. */
  async upsertPartner(p: OdooPartnerInput, opts?: RequestOptions): Promise<{ id: number }> {
    const conds: unknown[] = [];
    if (p.email) conds.push(["email", "=", p.email]);
    if (p.phone) conds.push(["phone", "=", p.phone]);
    if (p.externalRef) conds.push(["ref", "=", p.externalRef]);
    // Odoo domains are prefix-notation: n conditions need n-1 leading '|' ops.
    const domain: unknown[] = [...Array(Math.max(conds.length - 1, 0)).fill("|"), ...conds];
    const ids = conds.length
      ? await this.executeKw<number[]>("res.partner", "search", [domain], { limit: 1 }, opts)
      : [];
    const values: Record<string, unknown> = { name: p.name };
    if (p.email) values.email = p.email;
    if (p.phone) values.phone = p.phone;
    if (p.externalRef) values.ref = p.externalRef;
    if (ids.length > 0) {
      await this.executeKw("res.partner", "write", [[ids[0]], values], {}, opts);
      return { id: ids[0] };
    }
    const id = await this.executeKw<number>("res.partner", "create", [values], {}, opts);
    return { id };
  }

  /** Create a sale.order with one order_line per item. */
  async createSaleOrder(o: OdooSaleOrderInput, opts?: RequestOptions): Promise<{ id: number }> {
    const id = await this.executeKw<number>(
      "sale.order",
      "create",
      [
        {
          partner_id: o.partnerId,
          origin: o.origin ?? "WhatsApp Commerce",
          order_line: o.lines.map((l) => [
            0,
            0,
            {
              product_id: l.productId ?? false,
              name: l.name,
              product_uom_qty: l.quantity,
              price_unit: l.unitPrice,
            },
          ]),
        },
      ],
      {},
      opts,
    );
    return { id };
  }

  /**
   * Push an absolute stock level for the product with the given default_code
   * (SKU) into the first internal stock location via stock.quant.
   */
  async updateProductStock(input: { sku: string; quantity: number }, opts?: RequestOptions): Promise<{ updated: boolean }> {
    const productIds = await this.executeKw<number[]>(
      "product.product",
      "search",
      [[["default_code", "=", input.sku]]],
      { limit: 1 },
      opts,
    );
    if (productIds.length === 0) return { updated: false };
    const locationIds = await this.executeKw<number[]>(
      "stock.location",
      "search",
      [[["usage", "=", "internal"]]],
      { limit: 1 },
      opts,
    );
    if (locationIds.length === 0) {
      throw new IntegrationError("odoo", "no internal stock.location found", { retriable: false });
    }
    await this.executeKw(
      "stock.quant",
      "create",
      [{ product_id: productIds[0], location_id: locationIds[0], inventory_quantity: input.quantity }],
      {},
      opts,
    );
    return { updated: true };
  }

  /** Pull stock levels (sku → on-hand quantity) for inbound sync. */
  async getStockLevels(opts?: RequestOptions): Promise<Array<{ sku: string; quantity: number }>> {
    const rows = await this.executeKw<Array<{ default_code: string | false; qty_available: number }>>(
      "product.product",
      "search_read",
      [[["default_code", "!=", false]]],
      { fields: ["default_code", "qty_available"] },
      opts,
    );
    return rows
      .filter((r) => typeof r.default_code === "string" && r.default_code)
      .map((r) => ({ sku: r.default_code as string, quantity: r.qty_available }));
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createIntegrationClient(
  system: IntegrationSystem,
  config: IntegrationConfig,
): MedusaClient | TwentyClient | OdooClient {
  switch (system) {
    case "medusa":
      return new MedusaClient(config);
    case "twenty":
      return new TwentyClient(config);
    case "odoo":
      return new OdooClient(config);
  }
}
