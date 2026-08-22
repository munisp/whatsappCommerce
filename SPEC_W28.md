# Wave 28 SPEC — Odoo ERP sync + Medusa storefront integration

Base: main @ 631de877 (w28-share master @ 2a2fd3f). Same hard invariants as W26/W27 (see below). Both coders must read the Wave 27 bookkeeping and storefront code before designing.

## Hard invariants
- Additive-only schema; drizzle-kit BROKEN — hand-write SQL + journal + snapshot (derive from 0083 chain tip).
- Integer cents; no unseeded Math.random (shared/prng.ts); tenant-guarded tRPC (protectedProcedure+tenantId+assertTenantAccess / adminProcedure / internalProcedure / hardened public per tracking.ts exemplar); authz scanner green.
- Do NOT modify: payment.ts, paymentConfirm.ts (PINNED md5 2f77ea4816d1adc5cb35473bd35d1697), escrow.ts, orderCrud.ts, codFlow.ts internals. No package.json/lockfile changes.
- Shared-file protocol: schema.ts append at EOF under `// === W28 <feature> ===` banner; routers.ts/runner.ts/App.tsx/env.example.txt append-only under banner. Journal entries appended after idx 0083 in your branch; merger re-chains.
- Durability: clone file:///mnt/agents/output/w28-share to /tmp, work there, commit+push after EVERY step, rsync to /mnt/agents/output/w28/tree-<x>/ periodically. FUSE corruption of refs is usually TRANSIENT — never delete remote refs; retry after 10s.
- External APIs (Odoo XML-RPC/JSON-RPC, Medusa) must be adapter-based with deterministic mocks; tests never hit live endpoints.
- Gate per branch: tsc 0, targeted vitest green, your journeys pass.

## Coder A — w28/odoo-sync (mig 0084–0085, journeys J154–J157)
Bookkeeping → Odoo ERP:
1. `server/services/odoo/adapter.ts`: OdooAdapter interface (authenticate, createPartner, createInvoice, createVendorBill, createPayment, attachReceipt) + JSON-RPC/XML-RPC client impl (fetch-based, env-configured URL/db/api-key) + deterministic MockOdooAdapter (HMAC-derived ids, full state for assertions). Registry `getOdooAdapter(tenantId)` per-tenant config resolution (payment-registry pattern).
2. Tenant config: table `odoo_configs` (tenantId unique, url, db, apiKey ref, syncMode push|batch|ondemand, account mapping json, enabled). Portal settings page (connect/test connection/mode/field mapping).
3. Sync outbox: table `odoo_sync_outbox` (tenantId, entityType sale|expense|payout|loan_disbursement, entityId, payload json, status pending|sent|failed, attempts, lastError, unique tenantId+entityType+entityId = exactly-once). Event hooks: on order paid → invoice; on expense confirmed → vendor bill (receipt image attached); on payout/loan disbursement → payment. Batch mode: nightly cron (existing scheduled-cron pattern, isCron-guarded) posts summarized journal entries. Sync worker: claim-before-send, exponential-backoff-free deterministic retry (max attempts → failed + reconciliation queue surface in portal), no silent divergence.
4. WhatsApp: `odoo status` / `odoo sync now` commands for tenant admin (follow credit WhatsApp admin pattern).
5. Journeys: J154 connect+config validation; J155 paid order → invoice posted (mock asserts partner/invoice lines/integer cents); J156 expense receipt → vendor bill + attachment; J157 failure→retry→reconciliation surface (no dupes on retry).

## Coder B — w28/medusa-storefront (mig 0086–0087, journeys J158–J161)
Medusa ↔ storefront:
1. Per-tenant store mapping: table `medusa_store_mappings` (tenantId unique, medusaStoreId/salesChannelId, apiKeyRef, catalogSource platform|medusa, syncEnabled). This LIFTS the current admin-only medusa.ts restriction properly: tenant procedures resolve their own mapping; keep admin-only for cross-tenant ops.
2. Catalog sync Medusa→platform: webhook receiver endpoint (HMAC-verified per webhook patterns in _core/index.ts — additive block) for product.created/updated/deleted → upsert into platform products with `metadata.source="medusa"` + `metadata.medusaId` (idempotent upsert by medusaId, never clobber platform-native products). Backfill pull procedure (tenant-triggered full sync).
3. Storefront source toggle: storefront service (Wave 27 C's server/services/storefront.ts) gains catalog-source resolution — when tenant mapping says medusa, /shop/:slug renders from synced catalog (same public view-model, same hardening). Default unchanged (platform).
4. Order bridge: storefront checkout CTA for medusa-sourced items → order created in platform (existing rails: payment/escrow/COD unchanged) → outbound Medusa order creation via adapter (MockMedusaAdapter deterministic) → fulfillment status webhook back → existing delivery/escrow-release flow (via events/DB state, not editing escrow.ts).
5. Portal pages: Medusa connection settings (mapping, test, backfill, source toggle). Journeys: J158 mapping+backfill sync; J159 webhook upsert idempotency (replay-safe, platform-native untouched); J160 storefront renders medusa catalog after toggle (and reverts cleanly); J161 storefront order→medusa order→fulfillment webhook→escrow release path.

## Merger notes (main agent)
- Merge order A then B. Journal idx 84,85,86,87; rebuild snapshot chain cumulatively from 0083 tip. Journey count 153+8=161 (assertion 162). Union banner blocks. Full gate: tsc 0 (NODE_OPTIONS=--max-old-space-size=6144), full vitest, 161/161 journeys, authz green.
