/**
 * marketplace/connectors.ts — thin ConnectorDescriptor adapters.
 *
 * odoo/twenty/medusa delegate to the existing erpProvision connector seam
 * (isConfigured / testConnection), which itself resolves credentials from
 * integrationSync's authoritative config getters. Read-only delegation: this
 * module never mutates provider config.
 *
 * shopify conforms to the same seam but resolves dynamically: the connector
 * module (server/services/shopifyIntegration) is being built in parallel, so
 * it is imported lazily inside try/catch and credentials are read straight
 * from tenants.settings.integrations.shopify. This file compiles and its
 * tests pass with or without that module present.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import { ERP_CONNECTORS } from "../erpProvision/connectors";
import type { ConnectorDescriptor } from "./types";

// ─── odoo / twenty / medusa (delegate to erpProvision seam) ─────────────────

function erpBackedDescriptor(
  kind: "odoo" | "twenty" | "medusa",
  meta: { name: string; category: ConnectorDescriptor["category"]; logoKey: string; capabilities: string[] },
): ConnectorDescriptor {
  const backing = ERP_CONNECTORS.find((c) => c.kind === kind);
  if (!backing) throw new Error(`erpProvision connector missing for ${kind}`);
  return {
    key: kind,
    name: meta.name,
    category: meta.category,
    logoKey: meta.logoKey,
    capabilities: meta.capabilities,
    async isConfigured(tenantId) {
      return backing.isConfigured(tenantId).catch(() => false);
    },
    async healthCheck(tenantId) {
      // testConnection returns null when healthy, an honest error string
      // otherwise, and never throws — but belt-and-braces the seam anyway.
      try {
        const err = await backing.testConnection(tenantId);
        return err ? { ok: false, detail: err } : { ok: true };
      } catch (err: any) {
        return { ok: false, detail: `${kind} health check failed: ${err?.message ?? err}` };
      }
    },
  };
}

// ─── shopify (dynamic, absent-module tolerant) ───────────────────────────────

const SHOPIFY_MODULE_PATH = "../shopifyIntegration";

interface ShopifyModuleShape {
  testConnection?: (tenantId: string) => Promise<string | null>;
  isConfigured?: (tenantId: string) => Promise<boolean>;
  getInstallUrl?: (tenantId: string) => Promise<string | null>;
}

async function loadShopifyModule(): Promise<ShopifyModuleShape | null> {
  try {
    return (await import(/* @vite-ignore */ SHOPIFY_MODULE_PATH)) as ShopifyModuleShape;
  } catch {
    return null; // connector module not landed yet — descriptor still works
  }
}

interface ShopifySettings {
  url?: string;
  apiKey?: string;
  enabled?: boolean;
}

async function readShopifySettings(tenantId: string): Promise<ShopifySettings | null> {
  const db = await getDb();
  if (!db) return null;
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const integrations = (tenant?.settings as Record<string, any> | null)?.integrations;
  const shopify = integrations?.shopify as ShopifySettings | undefined;
  return shopify ?? null;
}

const shopifyDescriptor: ConnectorDescriptor = {
  key: "shopify",
  name: "Shopify",
  category: "storefront",
  logoKey: "shopify",
  capabilities: ["catalog-sync", "orders-sync", "webhooks"],
  async isConfigured(tenantId) {
    const mod = await loadShopifyModule();
    if (mod?.isConfigured) {
      try {
        return await mod.isConfigured(tenantId);
      } catch {
        /* fall through to settings read */
      }
    }
    const s = await readShopifySettings(tenantId).catch(() => null);
    return Boolean(s?.enabled && s.url && s.apiKey);
  },
  async healthCheck(tenantId) {
    const mod = await loadShopifyModule();
    if (mod?.testConnection) {
      try {
        const err = await mod.testConnection(tenantId);
        return err ? { ok: false, detail: err } : { ok: true };
      } catch (err: any) {
        return { ok: false, detail: `shopify health check failed: ${err?.message ?? err}` };
      }
    }
    // Module absent: fall back to a config-presence probe. Reported with a
    // detail note so the marketplace surfaces it as "degraded" (configured,
    // live probe pending) rather than fully healthy.
    const configured = await shopifyDescriptor.isConfigured(tenantId);
    return configured
      ? { ok: true, detail: "configured — live probe pending shopify connector module" }
      : { ok: false, detail: "shopify not configured" };
  },
  async installUrl(tenantId) {
    const mod = await loadShopifyModule();
    if (mod?.getInstallUrl) {
      try {
        return await mod.getInstallUrl(tenantId);
      } catch {
        return null;
      }
    }
    return null;
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const CONNECTOR_DESCRIPTORS: readonly ConnectorDescriptor[] = [
  erpBackedDescriptor("odoo", {
    name: "Odoo ERP",
    category: "erp",
    logoKey: "odoo",
    capabilities: ["orders-sync", "inventory-sync", "contacts-sync", "price-lists"],
  }),
  erpBackedDescriptor("twenty", {
    name: "Twenty CRM",
    category: "crm",
    logoKey: "twenty",
    capabilities: ["contacts-sync", "pipeline", "activities"],
  }),
  erpBackedDescriptor("medusa", {
    name: "Medusa Storefront",
    category: "storefront",
    logoKey: "medusa",
    capabilities: ["catalog-sync", "orders-sync", "regions"],
  }),
  shopifyDescriptor,
];

export function getConnectorDescriptor(key: string): ConnectorDescriptor | null {
  return CONNECTOR_DESCRIPTORS.find((d) => d.key === key) ?? null;
}
