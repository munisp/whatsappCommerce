# Middleware Stack

The WhatsApp Commerce Platform uses a polyglot middleware stack for event-driven processing, workflow orchestration, and caching.

## Architecture Overview

```
WhatsApp Cloud API
       │
       ▼
┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐
│  APISix Gateway │───▶│  Go Event Gateway │───▶│  Kafka Event Bus   │
│  (rate limit,   │    │  (webhook ingest, │    │  Topics:           │
│   auth, routing)│    │   fan-out, retry) │    │  - wa.messages     │
└─────────────────┘    └──────────────────┘    │  - kyc.events      │
                                                │  - orders.created  │
                                                │  - inventory.sync  │
                                                │  - agent.events    │
                                                └────────┬───────────┘
                                                         │
                              ┌──────────────────────────┼──────────────────────┐
                              ▼                          ▼                      ▼
                   ┌──────────────────┐    ┌────────────────────┐  ┌────────────────────┐
                   │  Rust Message    │    │  Python KYC        │  │  TypeScript Node   │
                   │  Processor       │    │  Verifier          │  │  Main App          │
                   │  (high-perf      │    │  (PaddleOCR, VLM,  │  │  (tRPC, business   │
                   │   dedup, routing)│    │   Docling, liveness│  │   logic, DB writes)│
                   └──────────────────┘    └────────────────────┘  └────────────────────┘
                              │
                              ▼
                   ┌──────────────────────────────────────────────────┐
                   │              Temporal Workflow Engine             │
                   │  Workflows:                                       │
                   │  - TenantOnboardingWorkflow (KYC → billing → WA) │
                   │  - OrderFulfillmentWorkflow (pay → ship → notify) │
                   │  - InventorySyncWorkflow (Odoo → DB → alerts)    │
                   │  - BroadcastCampaignWorkflow (schedule → send)   │
                   └──────────────────────────────────────────────────┘
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
          ┌──────────────┐     ┌──────────────────┐
          │  Redis Cache │     │  PostgreSQL DB    │
          │  - sessions  │     │  (primary store)  │
          │  - rate limit│     └──────────────────┘
          │  - pub/sub   │
          └──────────────┘
```

## Service Responsibilities

| Service | Language | Role |
|---|---|---|
| APISix Gateway | Lua/Go | Rate limiting, auth, routing, webhook validation |
| Go Event Gateway | Go | WhatsApp webhook ingestion, Kafka fan-out, retry logic |
| Rust Message Processor | Rust | High-performance deduplication, message routing, stream processing |
| Python KYC Verifier | Python | PaddleOCR, Docling, VLM analysis, liveness detection |
| TypeScript Node App | TypeScript | Business logic, tRPC API, database writes, WebSocket |
| Temporal | Go | Durable workflow orchestration with retries and timeouts |
| Kafka | JVM | Event bus, audit log, replay capability |
| Redis | C | Session cache, rate limiting, liveness sessions, pub/sub |
| Dapr | Go | Service mesh, state management, pub/sub abstraction |

## Kafka Topics

| Topic | Producer | Consumer(s) | Description |
|---|---|---|---|
| `wa.messages.inbound` | Go Gateway | Rust Processor, Node App | Incoming WhatsApp messages |
| `wa.messages.outbound` | Node App | Go Gateway | Outgoing WhatsApp messages |
| `kyc.events` | Python KYC | Node App, Temporal | KYC verification results |
| `orders.created` | Node App | Temporal, Inventory | New order events |
| `inventory.sync` | Temporal | Node App | Odoo stock sync results |
| `agent.events` | Node App | Temporal, Analytics | AI agent interaction events |
| `broadcast.scheduled` | Node App | Temporal | Campaign send triggers |

## Temporal Workflows

| Workflow | Trigger | Steps |
|---|---|---|
| `TenantOnboardingWorkflow` | New tenant created | KYC submit → review → billing setup → WhatsApp connect → activate |
| `OrderFulfillmentWorkflow` | Order placed | Payment confirm → inventory reserve → Odoo sync → WhatsApp notify |
| `InventorySyncWorkflow` | Heartbeat (5min) | Odoo XML-RPC pull → diff → DB update → low-stock alerts |
| `BroadcastCampaignWorkflow` | Campaign scheduled | Audience build → template render → send batches → track delivery |
| `KYCReviewWorkflow` | KYC submitted | Auto-score → human review queue → approve/reject → notify |

## Starting the Stack

```bash
# Start all middleware services
docker compose -f docker-compose.middleware.yml up -d

# Check status
docker compose -f docker-compose.middleware.yml ps

# Kafka UI: http://localhost:8080
# Temporal UI: http://localhost:8088
# APISix Admin: http://localhost:9180
```

