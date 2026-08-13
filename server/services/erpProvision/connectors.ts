/**
 * erpProvision/connectors.ts — per-connector provisioners behind a common
 * interface (roadmap F5, ERP-aware agentic configuration).
 *
 * Each connector knows how to:
 *   1. `isConfigured`  — resolve the tenant's credentials (single source of
 *      truth lives in integrationSync.ts resolvers).
 *   2. `testConnection`— prove the connection is live/tested before any
 *      external mutation is attempted.
 *   3. `provision`     — idempotently create/adopt the standard objects the
 *      platform relies on (see per-connector docblocks).
 *
 * Idempotency contract: the caller persists
 * settings.erpProvision.objects["<erp>:<object>"] = { externalId, ... } after
 * a successful run; connectors ALSO search-before-create so that objects
 * created outside this flow are adopted (status 'exists') instead of
 * duplicated.
 */
import {
  fetchJsonWithRetry,
  getMedusaIntegrationConfig,
  getOdooIntegrationConfig,
  getTwentyIntegrationConfig,
  odooAuthenticate,
  odooExecuteKw,
  type MedusaIntegrationConfig,
  type OdooIntegrationConfig,
  type TwentyIntegrationConfig,
} from "../integrationSync";

export type ErpKind = "odoo" | "twenty" | "medusa";

export interface ProvisionObjectResult {
  erp: ErpKind;
  object: string;
  externalId?: string;
  status: "created" | "exists" | "skipped" | "failed";
  error?: string;
}

export interface ProvisionContext {
  tenantId: string;
  /** Business display name (tenant.branding.name ?? tenant.name). */
  businessName: string;
  /** ISO currency (tenant commerce config). */
  currency: string;
  /** CRM pipeline stages from tenant settings (Twenty pipeline mapping). */
  pipelineStages: string[];
  /** Keys already recorded in settings.erpProvision.objects. */
  existing: Record<string, { externalId?: string | null }>;
  /** Dry-run: no network writes, no connectivity checks. */
  dryRun: boolean;
}

export interface ErpConnector {
  kind: ErpKind;
  /** Object keys this connector provisions (stable identifiers). */
  objects: string[];
  isConfigured(tenantId: string): Promise<boolean>;
  /**
   * Live connectivity check. Returns null when healthy, otherwise an honest
   * error string. Never throws.
   */
  testConnection(tenantId: string): Promise<string | null>;
  /**
   * Provision (or adopt) this connector's objects. Must isolate per-object
   * failures into the result rows instead of throwing; a thrown error fails
   * ALL of the connector's remaining objects (handled by the orchestrator).
   */
  provision(ctx: ProvisionContext): Promise<ProvisionObjectResult[]>;
}

// ─── Odoo ────────────────────────────────────────────────────────────────────

const ODOO_PARTNER_CATEGORY = "WhatsApp Commerce";
const ODOO_PRICELIST_SUFFIX = "WhatsApp Default";

async function odooFindByName(
  cfg: OdooIntegrationConfig,
  uid: number,
  model: string,
  name: string,
): Promise<number | null> {
  const ids = await odooExecuteKw(cfg, uid, model, "search", [[["name", "=", name]]], { limit: 1 });
  return Array.isArray(ids) && typeof ids[0] === "number" ? ids[0] : null;
}

export const odooConnector: ErpConnector = {
  kind: "odoo",
  objects: ["partner-category", "partner", "price-list"],

  async isConfigured(tenantId) {
    return (await getOdooIntegrationConfig(tenantId)) !== null;
  },

  async testConnection(tenantId) {
    const cfg = await getOdooIntegrationConfig(tenantId);
    if (!cfg) return "odoo not configured";
    try {
      await odooAuthenticate(cfg);
      return null;
    } catch (err: any) {
      return `odoo connection test failed: ${err?.message ?? err}`;
    }
  },

  async provision(ctx) {
    const results: ProvisionObjectResult[] = [];
    const cfg = await getOdooIntegrationConfig(ctx.tenantId);
    if (!cfg) {
      return this.objects.map((object) => ({
        erp: "odoo" as const,
        object,
        status: "skipped" as const,
        error: "odoo not configured",
      }));
    }
    if (ctx.dryRun) {
      return this.objects.map((object) => ({
        erp: "odoo" as const,
        object,
        status: ctx.existing[`odoo:${object}`] ? ("exists" as const) : ("skipped" as const),
        externalId: ctx.existing[`odoo:${object}`]?.externalId ?? undefined,
        error: ctx.existing[`odoo:${object}`] ? undefined : "dry-run: would create",
      }));
    }

    const uid = await odooAuthenticate(cfg); // throws → orchestrator fails all odoo objects

    // 1. partner category (res.partner.category)
    {
      const object = "partner-category";
      const known = ctx.existing[`odoo:${object}`];
      if (known?.externalId) {
        results.push({ erp: "odoo", object, externalId: known.externalId, status: "exists" });
      } else {
        try {
          const found = await odooFindByName(cfg, uid, "res.partner.category", ODOO_PARTNER_CATEGORY);
          if (found) {
            results.push({ erp: "odoo", object, externalId: String(found), status: "exists" });
          } else {
            const id = await odooExecuteKw(cfg, uid, "res.partner.category", "create", [
              { name: ODOO_PARTNER_CATEGORY },
            ]);
            results.push({ erp: "odoo", object, externalId: String(id), status: "created" });
          }
        } catch (err: any) {
          results.push({ erp: "odoo", object, status: "failed", error: err?.message ?? String(err) });
        }
      }
    }

    // 2. default customer partner (res.partner), tagged with the category
    {
      const object = "partner";
      const known = ctx.existing[`odoo:${object}`];
      const partnerName = `${ctx.businessName} — WhatsApp Customers`;
      if (known?.externalId) {
        results.push({ erp: "odoo", object, externalId: known.externalId, status: "exists" });
      } else {
        try {
          const categoryIdRaw = results.find((r) => r.object === "partner-category")?.externalId;
          const categoryId = categoryIdRaw ? parseInt(categoryIdRaw, 10) : null;
          const found = await odooFindByName(cfg, uid, "res.partner", partnerName);
          if (found) {
            results.push({ erp: "odoo", object, externalId: String(found), status: "exists" });
          } else {
            const id = await odooExecuteKw(cfg, uid, "res.partner", "create", [
              {
                name: partnerName,
                customer_rank: 1,
                ...(categoryId ? { category_id: [[6, 0, [categoryId]]] } : {}),
                comment: "Default partner for WhatsApp Commerce inbound orders",
              },
            ]);
            results.push({ erp: "odoo", object, externalId: String(id), status: "created" });
          }
        } catch (err: any) {
          results.push({ erp: "odoo", object, status: "failed", error: err?.message ?? String(err) });
        }
      }
    }

    // 3. price list (product.pricelist)
    {
      const object = "price-list";
      const known = ctx.existing[`odoo:${object}`];
      const pricelistName = `${ctx.businessName} — ${ODOO_PRICELIST_SUFFIX}`;
      if (known?.externalId) {
        results.push({ erp: "odoo", object, externalId: known.externalId, status: "exists" });
      } else {
        try {
          const found = await odooFindByName(cfg, uid, "product.pricelist", pricelistName);
          if (found) {
            results.push({ erp: "odoo", object, externalId: String(found), status: "exists" });
          } else {
            const id = await odooExecuteKw(cfg, uid, "product.pricelist", "create", [
              { name: pricelistName },
            ]);
            results.push({ erp: "odoo", object, externalId: String(id), status: "created" });
          }
        } catch (err: any) {
          results.push({ erp: "odoo", object, status: "failed", error: err?.message ?? String(err) });
        }
      }
    }

    return results;
  },
};

// ─── Twenty CRM ──────────────────────────────────────────────────────────────

async function twentyGraphql<T = any>(
  cfg: TwentyIntegrationConfig,
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<T> {
  const res = await fetchJsonWithRetry(
    `${cfg.baseUrl}/api`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    },
    { label },
  );
  if (!res.ok) throw new Error(`twenty ${label}: ${res.error}`);
  if (res.data?.errors) {
    throw new Error(`twenty ${label}: ${JSON.stringify(res.data.errors).slice(0, 300)}`);
  }
  return res.data?.data as T;
}

export const twentyConnector: ErpConnector = {
  kind: "twenty",
  objects: ["company", "pipeline"],

  async isConfigured(tenantId) {
    return (await getTwentyIntegrationConfig(tenantId)) !== null;
  },

  async testConnection(tenantId) {
    const cfg = await getTwentyIntegrationConfig(tenantId);
    if (!cfg) return "twenty not configured";
    try {
      await twentyGraphql(cfg, "{ __schema { queryType { name } } }", {}, "connection test");
      return null;
    } catch (err: any) {
      return `twenty connection test failed: ${err?.message ?? err}`;
    }
  },

  async provision(ctx) {
    const results: ProvisionObjectResult[] = [];
    const cfg = await getTwentyIntegrationConfig(ctx.tenantId);
    if (!cfg) {
      return this.objects.map((object) => ({
        erp: "twenty" as const,
        object,
        status: "skipped" as const,
        error: "twenty not configured",
      }));
    }
    if (ctx.dryRun) {
      return this.objects.map((object) => ({
        erp: "twenty" as const,
        object,
        status: ctx.existing[`twenty:${object}`] ? ("exists" as const) : ("skipped" as const),
        externalId: ctx.existing[`twenty:${object}`]?.externalId ?? undefined,
        error: ctx.existing[`twenty:${object}`] ? undefined : "dry-run: would create",
      }));
    }

    // 1. company record for the tenant's business
    {
      const object = "company";
      const known = ctx.existing[`twenty:${object}`];
      if (known?.externalId) {
        results.push({ erp: "twenty", object, externalId: known.externalId, status: "exists" });
      } else {
        try {
          const found = await twentyGraphql(
            cfg,
            `query FindCompany($name: String!) {
               companies(filter: { name: { eq: $name } }) { edges { node { id } } }
             }`,
            { name: ctx.businessName },
            "find company",
          );
          const existingId = (found as any)?.companies?.edges?.[0]?.node?.id;
          if (existingId) {
            results.push({ erp: "twenty", object, externalId: String(existingId), status: "exists" });
          } else {
            const created = await twentyGraphql(
              cfg,
              `mutation CreateCompany($name: String!) {
                 createCompany(input: { name: $name }) { id }
               }`,
              { name: ctx.businessName },
              "create company",
            );
            const id = (created as any)?.createCompany?.id;
            if (!id) throw new Error("createCompany returned no id");
            results.push({ erp: "twenty", object, externalId: String(id), status: "created" });
          }
        } catch (err: any) {
          results.push({ erp: "twenty", object, status: "failed", error: err?.message ?? String(err) });
        }
      }
    }

    // 2. pipeline mapping — Twenty pipelines are workspace-level and not
    //    safely creatable via API, so the platform pipeline stages are
    //    recorded as a tenant-side mapping (externalId null). This is the
    //    configuration state the copilot manages; no external mutation.
    {
      const object = "pipeline";
      const known = ctx.existing[`twenty:${object}`];
      if (known) {
        results.push({ erp: "twenty", object, status: "exists" });
      } else {
        results.push({
          erp: "twenty",
          object,
          status: "created",
          externalId: `pipeline:${ctx.pipelineStages.join(">")}`,
        });
      }
    }

    return results;
  },
};

// ─── Medusa ──────────────────────────────────────────────────────────────────

const MEDUSA_SALES_CHANNEL_SUFFIX = "WhatsApp Storefront";

export const medusaConnector: ErpConnector = {
  kind: "medusa",
  objects: ["sales-channel", "region"],

  async isConfigured(tenantId) {
    const cfg = await getMedusaIntegrationConfig(tenantId);
    return cfg !== null && cfg.adminApiKey !== null;
  },

  async testConnection(tenantId) {
    const cfg = await getMedusaIntegrationConfig(tenantId);
    if (!cfg?.adminApiKey) return "medusa not configured (admin api key missing)";
    const res = await fetchJsonWithRetry(
      `${cfg.baseUrl}/admin/products?limit=1`,
      { headers: { "x-medusa-access-token": cfg.adminApiKey } },
      { label: "medusa connection test", retries: 0 },
    );
    return res.ok ? null : `medusa connection test failed: ${res.error}`;
  },

  async provision(ctx) {
    const results: ProvisionObjectResult[] = [];
    const cfg = await getMedusaIntegrationConfig(ctx.tenantId);
    if (!cfg?.adminApiKey) {
      return this.objects.map((object) => ({
        erp: "medusa" as const,
        object,
        status: "skipped" as const,
        error: "medusa not configured",
      }));
    }
    if (ctx.dryRun) {
      return this.objects.map((object) => ({
        erp: "medusa" as const,
        object,
        status: ctx.existing[`medusa:${object}`] ? ("exists" as const) : ("skipped" as const),
        externalId: ctx.existing[`medusa:${object}`]?.externalId ?? undefined,
        error: ctx.existing[`medusa:${object}`] ? undefined : "dry-run: would create",
      }));
    }

    const headers = {
      "Content-Type": "application/json",
      "x-medusa-access-token": cfg.adminApiKey,
    };
    const channelName = `${ctx.businessName} — ${MEDUSA_SALES_CHANNEL_SUFFIX}`;

    // 1. sales channel for WhatsApp-originated orders
    {
      const object = "sales-channel";
      const known = ctx.existing[`medusa:${object}`];
      if (known?.externalId) {
        results.push({ erp: "medusa", object, externalId: known.externalId, status: "exists" });
      } else {
        try {
          const list = await fetchJsonWithRetry(
            `${cfg.baseUrl}/admin/sales_channels?name=${encodeURIComponent(channelName)}`,
            { headers },
            { label: "medusa find sales channel" },
          );
          const found = list.ok ? (list.data?.sales_channels ?? []).find((c: any) => c?.id) : null;
          if (found) {
            results.push({ erp: "medusa", object, externalId: String(found.id), status: "exists" });
          } else {
            const created = await fetchJsonWithRetry(
              `${cfg.baseUrl}/admin/sales_channels`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  name: channelName,
                  description: "Sales channel for orders originating from WhatsApp Commerce",
                }),
              },
              { label: "medusa create sales channel" },
            );
            if (!created.ok) throw new Error(created.error);
            const id = created.data?.sales_channel?.id;
            if (!id) throw new Error("create sales channel returned no id");
            results.push({ erp: "medusa", object, externalId: String(id), status: "created" });
          }
        } catch (err: any) {
          results.push({ erp: "medusa", object, status: "failed", error: err?.message ?? String(err) });
        }
      }
    }

    // 2. region mapping — adopt the first existing region whose currency
    //    matches the tenant commerce currency (regions carry tax/shipping
    //    config and are never auto-created by the platform).
    {
      const object = "region";
      const known = ctx.existing[`medusa:${object}`];
      if (known?.externalId) {
        results.push({ erp: "medusa", object, externalId: known.externalId, status: "exists" });
      } else {
        try {
          const list = await fetchJsonWithRetry(
            `${cfg.baseUrl}/admin/regions?limit=50`,
            { headers },
            { label: "medusa list regions" },
          );
          if (!list.ok) throw new Error(list.error);
          const regions = (list.data?.regions ?? []) as any[];
          const match =
            regions.find(
              (r) => String(r?.currency_code ?? "").toUpperCase() === ctx.currency.toUpperCase(),
            ) ?? regions[0];
          if (match?.id) {
            results.push({ erp: "medusa", object, externalId: String(match.id), status: "exists" });
          } else {
            results.push({
              erp: "medusa",
              object,
              status: "skipped",
              error: "no medusa region exists to map — create one in Medusa admin",
            });
          }
        } catch (err: any) {
          results.push({ erp: "medusa", object, status: "failed", error: err?.message ?? String(err) });
        }
      }
    }

    return results;
  },
};

export const ERP_CONNECTORS: readonly ErpConnector[] = [
  odooConnector,
  twentyConnector,
  medusaConnector,
];
