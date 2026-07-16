# Fluvio Topic Mapping — WhatsApp Commerce Platform

## Overview

Fluvio is used as a high-throughput, low-latency streaming layer for WhatsApp message events. The Rust-based `fluvio-consumer` service subscribes to Fluvio topics and forwards processed events to the Node.js application via a webhook endpoint.

## Topic Definitions

| Fluvio Topic | Source | Consumer | Description |
|---|---|---|---|
| `wa.messages.inbound` | Meta webhook handler | `fluvio-consumer` | Raw inbound WhatsApp messages |
| `wa.messages.outbound` | Node.js app | `fluvio-consumer` | Outbound messages queued for delivery |
| `wacommerce.orders.created` | Order creation tRPC | Dapr pub/sub bridge | New order events |
| `wacommerce.payments.initiated` | Payment orchestrator | TigerBeetle bridge | Payment initiation events |
| `wacommerce.inventory.updates` | Product update tRPC | ML stack | Inventory change events |
| `wacommerce.hermes.po_drafts` | Hermes skills Python | Node.js webhook | PO draft creation events |

## SmartModule: `wa-dedup`

The `filter.rs` SmartModule deduplicates inbound messages using an in-memory sliding window of 10,000 message IDs. This prevents double-processing when Meta retries webhook delivery.

### Build & Deploy

```bash
# Build the SmartModule (requires Rust + wasm32-wasip1 target)
cd services/fluvio-consumer
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release --features smartmodule

# Register with Fluvio
fluvio smart-module create wa-dedup \
  --wasm target/wasm32-wasip1/release/fluvio_consumer.wasm

# Create topics with SmartModule applied
fluvio topic create wa.messages.inbound --partitions 3 --replication 1
fluvio topic create wacommerce.orders.created --partitions 3 --replication 1
fluvio topic create wacommerce.payments.initiated --partitions 3 --replication 1
```

## X-API-Key Header Requirement

External API consumers (third-party integrations, partner systems) must include the `X-API-Key` header in all requests to `/api/external/*`. Keys are managed via the APISIX Admin API:

```bash
curl -X POST http://localhost:9180/apisix/admin/consumers \
  -H "X-API-KEY: ${APISIX_ADMIN_KEY}" \
  -d '{
    "username": "partner-system-1",
    "plugins": {
      "key-auth": { "key": "partner-api-key-here" }
    }
  }'
```

