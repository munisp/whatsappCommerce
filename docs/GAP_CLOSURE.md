# Gap Closure & Multi-Use-Case Platform — Implementation Record

**Date:** 2026-08-08
**Range:** main `a525ca89` → `7c025b66` (PRs #45–#50)
**Tests:** 584 → 729 passed / 7 skipped / 0 failed (28 → 30+ test files). `tsc --noEmit` 0 errors; `vite build` clean.

This wave closed every residual gap from `docs/COMPETITOR_BENCHMARK.md` and extended the platform from "ecommerce checkout bot" to a multi-use-case, per-tenant-configurable conversational platform.

## 1. Multi-use-case menus (PR #45, #47, #50)

- **Use-case registry** (`server/services/useCases.ts`): `shop` (NLP ordering), `track` (order status + tracking links), `support` (inquiry capture + admin notify), `booking` (appointment slot-filling), `handoff` (human escalation). Each tenant enables/disables/reorders/renames these.
- **Per-tenant menu config** (`tenants.settings.waMenu`, contract in `shared/waMenu.ts`): `{ greeting, useCases[{id,label,enabled,order}], customItems[{key,label,response}], fallback: "nlp"|"menu" }`. Default template provisioned at onboarding; zod-validated (unknown ids, empty labels, order collisions rejected).
- **Channel-agnostic renderer**: one menu engine renders WhatsApp text menus **and** USSD (`CON`/`END`) menus — `POST /ussd` (Africa's Talking format) drives the same session state machine. WhatsApp and backend share identical config, so a tenant's menu edit is live on both channels immediately.
- **Session state** (`server/services/chatSession.ts`): Redis-backed (`wa:sess:{tenant}:{phone}`, TTL 30 min); dev-only in-memory fallback; production without Redis degrades to stateless menus, never crashes.
- **Admin Menu Builder** (`/wa-menu-builder`): visual editor + live WhatsApp phone preview rendered from the draft config with live catalog/order counts (top-5 in-stock items, open-order counts).

## 2. Inventory robustness — never charge for missing stock (PR #46)

- **Pre-payment guard**: chat `confirm_order` and `orderCrud.create` run `checkAvailability` *before* any payment link exists; shortage → reply naming unavailable items + adjusted available cart. No order row, no payment link.
- **Atomic reservations** (`inventory_reservations`, migration 0031): order insert + stock decrement in one transaction using `UPDATE products SET stockQuantity = stockQuantity - qty WHERE id AND tenantId AND stockQuantity >= qty RETURNING`; zero rows → whole transaction rolls back. Overselling is structurally impossible.
- **Lifecycle**: reserve (15-min TTL) → commit on `paymentConfirm` success (the single claim-first money path) → release on cancel/fail/expiry (idempotent, sweeper endpoint `/api/scheduled/inventory-reservation-sweep`).
- **Proven by tests**: concurrent last-unit race (exactly one winner, stock never negative), multi-item rollback, double-release idempotency, sweeper correctness.

## 3. Bidirectional Medusa / Twenty / Odoo integration (PR #49)

- **Outbound (platform → systems)**: local mutations (order created/confirmed, customer upsert, product create/update) enqueue `integration_events` (migration 0032) — a transactional outbox. Dispatcher delivers via per-tenant REST clients (Medusa admin REST, Twenty REST, Odoo JSON-RPC) with 10s timeout, 3× exponential backoff, dead-letter after 5 attempts. No fire-and-forget loss.
- **Inbound (systems → platform)**: `POST /integrations/:system/webhook` with per-tenant HMAC-SHA256 verification (`timingSafeEqual`, fail-closed in production). Medusa product/inventory → catalog (+stock), Twenty person → customers, Odoo stock → products. Loop guard (`origin` marker) prevents echo storms.
- **Middleware wiring**: events flow through the outbox dispatcher (cron `/api/scheduled/integration-outbox-dispatch`), consistent with the platform's existing retry-job pattern; router exposes `getConfig/setConfig` (masked secrets), `testConnection` (live), `syncStatus`, `resync`, `listEvents`.
- **Admin UI** (`/integration-settings`): per-system cards with live connection test, sync status badges, paginated event log, manual resync.

## 4. Tenant onboarding & customization (PR #47, #50)

- **Onboarding pipeline**: `draft → configuring → validating → live|failed`. `validate` performs *live* checks (WhatsApp Graph API `GET /{phoneNumberId}`, integration test-connections); `activate` is blocked until validation passes. Provisioning seeds the full default settings skeleton (commerce NGN, branding, CRM pipeline, inventory source, default waMenu).
- **Per-tenant customization APIs** (`tenantConfig` router, all `assertTenantAccess`-guarded): CRM (custom fields CRUD, pipeline stages), inventory (source: local/Medusa/Odoo, low-stock threshold), commerce (currency, pickup, delivery zones, fee overrides), branding (portal name/logo/color — applied live to the admin shell via `tenantTheme`), domains, and full WhatsApp menu CRUD.
- **Admin UI**: Onboarding Wizard (`/onboarding-wizard`, 7 steps with per-check validation results) and Tenant Settings (`/tenant-settings`, tabbed).

## 5. Residual gaps from benchmark — closed (PR #45, #48)

| Gap (benchmark doc) | Resolution |
|---|---|
| Emoji-reaction tracking | Reaction webhook branch → latest shipment status + tracking link reply |
| Multi-domain storefronts | Host→tenant middleware (`settings.domains` / `{slug}.app` subdomain, 60s cache) + public `tenantTheme` |
| WA consent capture | First-inbound NDPR opt-in prompt; `consents` table (0035); `hasConsent` fail-closed |
| Broadcast simulated | Real batch sends via per-tenant sender; consent-gated audience; 24h-window text/template split; per-tenant rate limit (fail-closed); dryRun |
| Template notifications global sender | All sends routed through `waSender` per-tenant creds; env sender path removed; chat-order recipient resolution fixed |
| USSD stub | Real session-driven USSD endpoint on the shared menu engine |

**Remaining honest residuals:** receipt verification remains vision-heuristic (±₦100, manual-review fallback — by design); integration test-connection endpoints are verified against documented API shapes, not live third-party sandboxes; operator-side deploy items unchanged (NODE_ENV, secrets, cron wiring for sweeper/outbox endpoints, redeploy client bundle).

## Validation

- `tsc --noEmit`: 0 errors at every merge
- `vitest run`: 729 passed / 7 skipped / 0 failed on final main
- `vite build`: clean
- Independent verifier gate: see final report (fresh clone @ 7c025b66)
