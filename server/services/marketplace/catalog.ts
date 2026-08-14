/**
 * marketplace/catalog.ts — built-in connector catalog (marketing metadata).
 *
 * Listing here is what makes a connector visible in the marketplace. Every
 * entry MUST have a matching descriptor in ./connectors.ts (enforced by
 * tests). Add a new connector by (1) writing a descriptor, (2) adding a
 * catalog entry here — see README.md.
 */
import type { CatalogEntry } from "./types";

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  {
    key: "odoo",
    name: "Odoo ERP",
    tagline: "Sync orders, stock levels and customers with your Odoo ERP.",
    category: "erp",
    logoKey: "odoo",
    setupTime: "15 min",
    capabilities: ["orders-sync", "inventory-sync", "contacts-sync", "price-lists"],
    requiredConfigFields: ["baseUrl", "database", "username", "apiKey"],
  },
  {
    key: "twenty",
    name: "Twenty CRM",
    tagline: "Push WhatsApp contacts and deal activity into Twenty CRM.",
    category: "crm",
    logoKey: "twenty",
    setupTime: "10 min",
    capabilities: ["contacts-sync", "pipeline", "activities"],
    requiredConfigFields: ["baseUrl", "apiKey"],
  },
  {
    key: "medusa",
    name: "Medusa Storefront",
    tagline: "Publish your WhatsApp catalog and orders to a Medusa storefront.",
    category: "storefront",
    logoKey: "medusa",
    setupTime: "10 min",
    capabilities: ["catalog-sync", "orders-sync", "regions"],
    requiredConfigFields: ["baseUrl", "adminApiKey"],
  },
  {
    key: "shopify",
    name: "Shopify",
    tagline: "Connect your Shopify store for catalog and order sync.",
    category: "storefront",
    logoKey: "shopify",
    setupTime: "5 min",
    capabilities: ["catalog-sync", "orders-sync", "webhooks"],
    requiredConfigFields: ["shopDomain", "accessToken"],
  },
];

export function getCatalogEntry(key: string): CatalogEntry | null {
  return CONNECTOR_CATALOG.find((e) => e.key === key) ?? null;
}
