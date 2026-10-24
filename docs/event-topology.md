# Event Topology (W62 F8)

Catalog of every async topic/bus in the platform: producer, consumer,
persistence, and status (`active` / `dormant`). Source: W61 events graph
audit (`events-notes.md`), verified against code on `w62/findings`.

Legend — **dormant** means the pipe exists in code but no producer feeds it
or no consumer drains it; data intended for it either never flows or flows
into the void. Dormant TS-side producers are env-gated behind
`DORMANT_TOPICS_ENABLED=true` (see `server/kafka.ts::dormantTopicsEnabled`).

## Kafka topics

| Topic | Producer | Consumer | Persistence | Status |
|---|---|---|---|---|
| wacommerce.orders | `server/kafka.ts::publishOrderEvent` | message-processor (rust, `orders.created` handler is a stub) | fluvio_event_log landing | active (partial) |
| wacommerce.payments | `server/kafka.ts::publishPaymentEvent` (never called) | none | — | **dormant** (env-gated W62) |
| wacommerce.conversations | `server/kafka.ts::publishConversationEvent` | none identified | fluvio_event_log | active (partial) |
| wacommerce.inventory | `server/kafka.ts::publishInventoryEvent` (never called) | none | — | **dormant** (env-gated W62) |
| wacommerce.hermes.po | `server/kafka.ts::publishHermesPOEvent` (never called) | none | — | **dormant** (env-gated W62) |
| hermes.events.inbound | platform → Hermes bridge | services/hermes-bridge | — | active |
| hermes.events.outbound | hermes-bridge / hermes-router (rust) | none | — | **dormant** (annotated W62) |
| hermes.events.dlq | hermes-bridge | none (metric counter only; Redis `hermes:dlq` drained by /api/scheduled/dlq-drain since W61) | Redis list → fluvio_event_log | active (drain wired W61) |
| wa.messages.inbound | event-gateway | message-processor subscribes `wa.message.received` (namespace mismatch, W61 #1) | Redis dedupe `msgproc:seen:*` | active (partial) |
| wa.messages.outbound | event-gateway | — | — | active |
| kyc.events | event-gateway | message-processor (stub handler) | Redis dedupe | active (partial) |
| wa.message.received / wa.message.status | (docs/Go ingestor) | message-processor (stub handlers) | Redis dedupe | active (partial) |
| orders.created | (docs) | message-processor (stub handler) | Redis dedupe | active (partial) |
| inventory.sync | (docs) | message-processor (stub handler) | Redis dedupe | active (partial) |
| mp.dlq.events | message-processor | /api/scheduled/dlq-drain (W61) | Redis list → fluvio_event_log | active |
| notifications.dispatch | none | notification-service (Go) | Redis dedupe | **dormant** (no producer; annotated W62) |
| notifications.dlq | notification-service | /api/scheduled/dlq-drain spill (W61) | Redis spill → fluvio_event_log | active |
| chat.message.received.v1 | webhook-ingestor (Go, chatwoot handler) | none | — | **dormant** (annotated W62) |
| recon.discrepancy / recon.run | rust/recon-worker | /api/scheduled/fluvio-event-sweep (W61) | fluvio_event_log | active |
| webhooks.inbound | declared in docs only | — | — | **dormant** (docs-only) |

## Dapr pubsub (whatsapp-pubsub)

| Topic | Producer | Consumer | Status |
|---|---|---|---|
| wacommerce.payments.<eventType> | `server/dapr.ts::publishPaymentEvent` | dapr subscribers (sidecar) | active |
| wacommerce.inventory.<eventType> | `server/dapr.ts::publishInventoryEvent` | dapr subscribers | active |
| payment.initiated / payment.failed | `server/routers/payment.ts` | dapr subscribers | active |

## Outbox / sweep tables (durable handoffs)

| Table | Writer | Sweeper / consumer | Status |
|---|---|---|---|
| payment_outbox | payment flows | scheduled outbox dispatch | active |
| medusa_promo_outbox | medusa promo | scheduled sweep (J604) | active |
| integration_events (out) | sync engine | integration-outbox-dispatch | active |
| odoo_sync_outbox | odoo sync | scheduled dispatch | active |
| telegram_outbox | telegramSender | /api/scheduled/telegram-send-retry (W61) | active |
| whatsapp_notification_log | waSender | /api/scheduled/wa-send-retry | active |
| bureau_report_log/outbox | bureau | /api/scheduled/bureau-report | active |
| credit_ledger (settlement_retry markers) | settlement | /api/internal/sweeps | active |
| wallet-statement manifest (filesystem) | walletStatements | derivable from DB | active (acceptable) |
| wa_webhook_events | WA webhook intake | /api/scheduled/wa-webhook-retry (+ W62 F13 dead-row admin alert) | active |
| email_outbox | emailOutbox.enqueueEmail (W62 F9) | /api/scheduled/email-send-retry (W62) | active |
| raw_webhook_events | PSP webhook routes (W61) | fluvio-event-sweep backlog check | active |
| fluvio_event_log | fluvio bridge + dlq-drain | /api/scheduled/fluvio-event-sweep (W61) | active |

## Temporal workflows

TenantOnboarding, OrderFulfillment, InventorySync, BroadcastCampaign —
deterministic workflowIds + REJECT_DUPLICATE; unwired activities throw
`activity_not_wired`. All active.
