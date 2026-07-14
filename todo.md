# WhatsApp Commerce Platform — TODO

## Database Schema
- [x] Users table with multi-role support (user, admin, operator, analyst)
- [x] Tenants table with plan, status, WhatsApp/Chatwoot config, AI settings
- [x] Products table with SKU, pricing, stock, low-stock threshold
- [x] Customers table with WhatsApp phone, CRM link, spend tracking
- [x] Conversations table with status, flow step, intent, escalation tracking
- [x] Orders table with status, payment status, items, shipping address
- [x] Payment intents table with provider, idempotency key, ledger ID
- [x] Agent events table with intent, confidence, latency, token usage
- [x] Webhook events table with source, type, status, payload
- [x] Service health table with per-service status, latency, error rate

## Backend (TypeScript/tRPC)
- [x] Tenant router: list, stats, get, create, update
- [x] Product router: list, stats, create, update
- [x] Conversation router: list, stats
- [x] Order router: list, stats
- [x] Payment router: list
- [x] Agent router: stats, health
- [x] Analytics router: platformOverview, tenantDashboard
- [x] Auth router: me, logout
- [x] DB helpers for all entities with aggregation queries

## Frontend (React/TypeScript)
- [x] Dark teal/slate theme with OKLCH color system
- [x] Inter + JetBrains Mono fonts
- [x] Landing page with feature grid and tech stack
- [x] Dashboard with KPI cards, revenue chart, conversation chart, tenant metrics
- [x] Tenants page: list, stats, create dialog, click-through to detail
- [x] Tenant detail page: metrics, edit form (plan, status, AI config, WhatsApp/Chatwoot)
- [x] Products page: catalog, stats, search, create dialog
- [x] Conversations page: live monitor, status filter, stats
- [x] Orders page: list, status filter, stats
- [x] Payments page: payment intents, provider badges, stats
- [x] AI Agent console: intent distribution, service health, architecture info
- [x] Service health page: all 10 services with language badges and status
- [x] DashboardLayout with full platform navigation (8 sections)

## Go Services (Monorepo)
- [x] API Gateway: APISIX-style reverse proxy, rate limiting, JWT validation, tenant routing
- [x] Webhook Ingestor: Chatwoot webhook verification, HMAC validation, Kafka producer
- [x] Conversation Orchestrator: session resolution, intent routing, menu engine, handoff manager
- [x] Commerce Engine: catalog, cart, checkout, orders, inventory projections
- [x] Payment Orchestrator: Mojaloop/Stripe integration, idempotent payment workflows

## Rust Services (Monorepo)
- [x] Event Processor: Kafka consumer with exactly-once semantics, event routing
- [x] Ledger Bridge: TigerBeetle two-phase financial accounting bridge
- [x] Recon Worker: periodic financial reconciliation, discrepancy detection

## Python AI Agent Layer (Monorepo)
- [x] LangGraph orchestrator with state machine and intent routing
- [x] Commerce tools: product search, cart management, checkout, order status
- [x] Conversation memory with Redis-backed sliding window
- [x] Guardrails: PII redaction, injection detection, sentiment escalation
- [x] FastAPI server with health, process, and webhook endpoints

## Infrastructure
- [x] Docker Compose for local development (all services)
- [x] Kubernetes manifests (Deployments, Services, HPA, NetworkPolicy)
- [x] GitHub Actions CI/CD pipeline
- [x] Environment configuration (.env.example)
- [x] Vitest integration tests

## Pending / Future
- [ ] Real-time WebSocket push for live conversation updates
- [ ] Live WhatsApp Business API webhook endpoint integration
- [ ] Stripe/Mojaloop live payment provider integration (keys required)
- [ ] Customer CRM view with full conversation history timeline
- [ ] Bulk product import via CSV upload
- [ ] Multi-language AI agent responses (i18n)
- [ ] Prometheus/Grafana metrics dashboards
- [ ] Istio service mesh configuration for mTLS
- [ ] Tenant onboarding wizard UI
- [ ] Agent performance A/B testing framework
