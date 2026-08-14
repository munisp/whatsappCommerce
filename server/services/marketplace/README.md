# Integrations Marketplace Lite (roadmap F7)

A deliberately shallow connector layer over the existing Odoo / Twenty /
Medusa sync and the Shopify connector. Scope is **registry, install/uninstall,
health** — nothing more. We intentionally do not build a 200-connector
catalog: breadth is a maintenance trap, not a moat.

## What it does

- **Registry** — `CONNECTOR_CATALOG` (marketing metadata) + `CONNECTOR_DESCRIPTORS`
  (runtime seam). `listConnectors({ tenantId })` enriches each catalog entry
  with per-tenant status (`not_installed | configured | error | degraded`),
  live health, and `installUrl` where a connector provides one.
- **Install** — guided-config, fail-closed state machine:
  1. connector credentials not yet configured in the provider's own flow →
     `awaiting_config` + `requiredFields` (nothing persisted);
  2. configured → live `healthCheck` gate; a failed probe **never activates**
     (attempt is audit-logged as `marketplace.connector.install_failed`);
  3. healthy → activation persisted to `tenants.settings.marketplace` (jsonb,
     no migration) and audit-logged. Re-install is an idempotent no-op.
- **Uninstall** — deactivates while preserving the install record (audit
  trail), writes `marketplace.connector.uninstall`, and returns a
  data-retention note (no synced data is deleted). Idempotent.
- **Health** — `marketplaceHealth({ tenantId })` aggregates per-connector
  health behind a 60s per-tenant in-memory cache and **never throws**: a
  failing connector becomes an `{ ok: false }` entry.

## How a new connector gets listed

1. **Write a descriptor** in `./connectors.ts` implementing the frozen seam
   (`ConnectorDescriptor` in `./types.ts`): `key`, `name`, `category`,
   `logoKey`, `capabilities`, `isConfigured(tenantId)`, `healthCheck(tenantId)`,
   optional `installUrl(tenantId)`. Descriptors must be read-only over
   provider config and never throw from `healthCheck` (return `{ ok: false,
   detail }` instead). If the connector's module may not exist yet, resolve it
   dynamically (see the `shopify` descriptor).
2. **Add a catalog entry** in `./catalog.ts` with the same `key`, a tagline,
   setup-time estimate, category (`erp | crm | storefront | payments |
   channel`), capabilities, and the `requiredConfigFields` operators complete
   in the provider's own config flow.

That's it — the registry, router (`server/routers/marketplace.ts` →
`listConnectors` / `installConnector` / `uninstallConnector` /
`connectorHealth`), caching, audit, and tests pick it up automatically.
Catalog↔descriptor integrity is enforced by `server/marketplace.test.ts`.

## Boundaries

- No credential management here: each provider keeps its own authoritative
  config flow (odoo/twenty/medusa via `integrationSync.ts` config getters).
- No new dependencies, no migrations (state is `tenants.settings.marketplace`
  jsonb).
- Mutations are operator-gated (`operatorProcedure`); reads are
  tenant-scoped (`protectedProcedure` + `assertTenantAccess`).
