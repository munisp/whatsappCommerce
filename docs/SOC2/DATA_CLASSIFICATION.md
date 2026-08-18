# Data Classification

Four tiers. Table names are the physical names in `drizzle/schema.ts`.

## Tier 1 — SECRET (never in DB rows / logs / client)

| Data | Location | Handling |
|---|---|---|
| JWT/session signing keys, master encryption keys | env only (`JWT_SECRET`, `SECRETS_MASTER_KEY` per `env.example.txt`) | env injection; rotation per CHANGE_MANAGEMENT.md §4; placeholder-only in example file (verified by `scripts/soc2-check.ts`) |
| Payment provider secret keys (Paystack), WhatsApp access tokens, LLM API keys | env / `payment_gateway_configs` (encrypted at rest) | never logged; never returned by tRPC |
| Webhook verify tokens | env (`WHATSAPP_VERIFY_TOKEN`) | signature checks at webhook edge |

## Tier 2 — PII (restricted)

| Table | PII content |
|---|---|
| `users` | operator name, phone, auth identifiers |
| `customers` | end-customer name, WhatsApp phone number, address/location |
| `conversations`, `whatsapp_media_files` | message content, media (may embed PII) |
| `kyc_applications`, `kyc_documents`, `liveness_checks` | identity documents, biometrics — **highest PII sensitivity** |
| `tenant_sso_profiles`, `tenant_memberships` | operator identity & roles |
| `twenty_contacts` (optional) | CRM contact PII when integration enabled |
| `broadcast_recipients` | recipient phone numbers |

Handling: tenant-scoped access only (authz ratchet, CC6.1); consent enforced
via `server/services/consent.ts`; retention per `retention_policies`;
access reviewed via `compliance.accessReview`.

## Tier 3 — FINANCIAL (restricted)

| Table | Content |
|---|---|
| `orders`, `order_items` | order values, fulfilment state |
| `payment_intents`, `payment_transactions` | payment attempts/settlements (state changes only via `server/services/paymentConfirm.ts`) |
| `cod_events` | rider cash collection events (`server/services/codFlow.ts`) |
| `refunds`, `invoices` | financial documents |
| `escrow_transactions`, `escrow_config`, `merchant_wallets`, `wallet_transactions`, `float_income_entries` | escrow/wallet ledgers |
| credit accounts & manufacturer programs | trade-credit balances and drawdowns (`server/services/tradeCredit/`, `server/services/manufacturerPrograms.ts`) |
| `cogs_dispute_requests`, `escrow_disputes` | financial disputes |

Handling: immutable/append-style ledgers where possible; reconciliation
(`server/services/reconMatch.ts`); audit-chained mutations (CC4.1).

## Tier 4 — INTERNAL / PUBLIC

| Tier | Tables/examples |
|---|---|
| Internal | `products`, `whatsapp_menus`, `whatsapp_menu_items`, `broadcast_campaigns`, `whatsapp_templates`, `template_versions`, `alert_rules`, `service_health`, `webhook_events`, `agent_events`, `forecast_snapshots` |
| Internal (security telemetry) | audit log rows (hash-chained), `incidents` — integrity-protected, admin-visible |
| Public | published catalog/menu content rendered to WhatsApp end users |

## Cross-cutting rules

- **Logs**: no Tier 1 ever; Tier 2 minimized (IDs over values) in
  `server/services/observability.ts` output.
- **Backups**: inherit the highest tier of included data (Tier 2/3 → encrypted,
  restricted restore).
- **Exports/evidence**: `client/src/pages/EvidencePortal.tsx` flows are
  time-boxed, token-scoped (`server/services/trackingToken.ts`).
