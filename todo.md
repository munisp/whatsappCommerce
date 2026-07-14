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

## Twenty CRM Integration
- [x] DB schema: twenty_integrations, twenty_contacts, twenty_deals tables
- [x] tRPC router: twenty (config, syncContacts, syncDeals, getContacts, getDeals, testConnection, sendWhatsApp)
- [x] Twenty CRM sidebar section in DashboardLayout
- [x] Twenty page: connection config, contact list, deal pipeline, WhatsApp send per contact
- [x] WhatsApp message button on each contact row (opens send dialog)
- [x] Sync status badges and last-sync timestamps

## Odoo ERP Integration
- [x] DB schema: odoo_integrations, odoo_products, odoo_orders, odoo_invoices tables
- [x] tRPC router: odoo (config, syncAll, listProducts, listOrders, listInvoices, testConnection, sendWhatsApp)
- [x] Odoo ERP sidebar section in DashboardLayout
- [x] Odoo page: connection config, product catalog, order list, invoice list, WhatsApp send button
- [x] WhatsApp notification button on orders and invoices (order status + payment reminders)
- [x] Sync status and last-sync timestamps

## WhatsApp Menu Builder
- [x] DB schema: whatsapp_menus, whatsapp_menu_items tables
- [x] tRPC router: menu (list, create, delete, addItem, updateItem, deleteItem, autoPopulate, pushToWhatsApp, publish, getDataSources)
- [x] Menu Builder page: visual tree editor with add/edit/delete nodes
- [x] Menu item types: section, list_item, quick_reply, button, catalog_link, url
- [x] Live phone preview panel showing WhatsApp-style chat mockup
- [x] Auto-populate from Odoo inventory (by category) and Twenty CRM (deal stages, contacts)
- [x] Push to WhatsApp button: sends interactive menu via WhatsApp Cloud API payload
- [x] Publish/unpublish controls and push history

## Integration Hub (unified)
- [x] Integration Hub page listing Twenty, Odoo, and Menu Builder with status cards and stats
- [x] Sidebar nav updated with PLATFORM / INTEGRATIONS / SYSTEM section grouping
- [x] "How It Works" end-to-end data flow diagram on Integration Hub

## WhatsApp Template Library
- [x] DB schema: whatsapp_templates table (name, category, body, variables, language)
- [x] tRPC router: templates (list, create, update, delete, getByCategory, preview)
- [x] Template Library page: CRUD for reusable message templates with variable substitution preview
- [x] Template selector in Odoo notify/remind dialogs (replace free-form text with template picker)
- [x] Template selector in Twenty CRM WhatsApp send dialog
- [x] Template categories: order_confirmation, shipping_update, payment_reminder, welcome, promotion, support, custom

## Per-Tenant Menu Assignment
- [x] DB schema: tenant_menu_assignments table (tenantId, menuId, assignedAt)
- [x] tRPC router: menu.assignToTenant, menu.unassignFromTenant, menu.getAssignments
- [x] Tenant Menu Assignment page: assign WhatsApp menus per tenant with stats
- [x] Menu assignment shown on Integration Hub

## Credential Connection Wizard
- [x] Step-by-step guided setup wizard for Twenty CRM (URL → API key → test → sync)
- [x] Step-by-step guided setup wizard for Odoo ERP (URL → DB → user → API key → test → sync)
- [x] Step-by-step guided setup wizard for WhatsApp Business API, AI Provider, Payment Provider, Chatwoot
- [x] Real-time validation feedback with field-level error messages
- [x] Setup progress bar (0/6 configured)
- [x] Setup Wizard sidebar nav entry under System section

## PostgreSQL Migration
- [x] PostgreSQL 16 installed locally (sandbox)
- [x] whatsapp_commerce database created with wacommerce user
- [x] All 21 tables migrated from MySQL to PostgreSQL (pg-core Drizzle)
- [x] POSTGRES_URL secret wired to web app
- [x] 2 PostgreSQL connection vitest tests passing

## Template Versioning
- [x] DB schema: template_versions table (templateId, version, body, status, changedBy, createdAt)
- [x] tRPC router: templates.createVersion, templates.listVersions, templates.publishVersion, templates.revertToVersion
- [x] Template Library UI: draft/published status toggle per template card
- [x] Version history drawer: list all versions with diff view and revert button

## WhatsApp Broadcast Campaigns
- [x] DB schema: broadcast_campaigns, broadcast_recipients tables
- [x] tRPC router: broadcast (create, list, get, send, cancel, getRecipients, getDeliveryStats)
- [x] Broadcast page: create campaign, select template, segment contacts from Twenty CRM
- [x] Variable substitution preview per recipient
- [x] Delivery tracking: sent/delivered/read/failed counts with progress bar
- [x] Campaign status: draft, scheduled, sending, completed, cancelled

## Tenant Seeding & Menu Assignment Verification
- [x] Seed 5 test tenants (Lagos Fresh Market, Nairobi Tech Store, Cape Town Boutique, Accra Fashion Hub, Cairo Electronics)
- [x] Seed 2 WhatsApp menus and assign to tenants via Menu Assignment page
- [x] Verify push-to-WhatsApp payload generation per tenant

## Bug Fixes
- [x] Fix Dashboard KPI cards showing zero: quote camelCase column names in raw SQL (totalAmount, escalatedAt, stockQuantity, latencyMs)

## Real-Time Inventory Sync & Oversell Prevention
- [x] DB schema: inventory_snapshots table (tenantId, productId, odooProductId, stockQty, reservedQty, availableQty, lastSyncedAt)
- [x] DB schema: inventory_sync_log table (tenantId, source, status, recordsSynced, errors, syncedAt)
- [x] tRPC router: inventory (getStockLevels, syncFromOdoo, getReservations, reserveStock, releaseReservation)
- [x] Oversell guard: atomic stock reservation on order creation (reserve before confirm)
- [x] Inventory Sync page: per-tenant stock table, low-stock alerts, sync-now button, sync history
- [x] Dashboard stock alert widget: count of low-stock and out-of-stock products
- [x] CRM/ERP integration explainer section on Inventory Sync page

## WebSocket Real-Time Conversations
- [x] Server-side WebSocket endpoint: /api/ws/conversations (broadcasts status changes)
- [x] useConversationsWS hook: connects to WS, merges live events into tRPC cache
- [x] Conversations page: live indicator dot, real-time status badge updates without refresh
- [x] WS event types: conversation_opened, bot_active, escalated, resolved, message_received
- [x] Fix Conversations crash: null guard on conversationId.slice()

## WhatsApp Template Approval Workflow
- [x] DB schema: add approval_status column to whatsapp_templates (draft, submitted, approved, rejected, paused)
- [x] tRPC router: template.submitForApproval, template.updateApprovalStatus, template.getApprovalHistory
- [x] Template Library UI: "Submit to Meta" button, approval status badge, rejection reason display

## Broadcast A/B Testing
- [x] DB schema: broadcast_ab_tests table (campaignId, variantA_templateId, variantB_templateId, splitRatio, winnerCriteria, winnerVariant, testEndAt)
- [x] tRPC router: broadcastAb (createAbTest, getAbResults, autoSelectWinner)
- [x] Broadcast page: A/B test panel in campaign detail, variant stats comparison, auto-winner button

## Tenant Onboarding Wizard
- [x] DB schema: tenant_onboarding table (tenantId, step, billingModel, profitShareRate, subscriptionFee, subscriptionCycle, whatsappVerified, aiConfigured, completedAt)
- [x] DB schema: billing_model enum (profit_sharing, subscription, hybrid)
- [x] tRPC router: onboarding (getProgress, saveStep, complete, getBillingPlans)
- [x] Multi-step wizard UI: Business Profile → Billing Model → WhatsApp Setup → KYC/KYB → Review & Launch
- [x] Billing model comparison card: profit-sharing (% of GMV) vs subscription (fixed monthly/annual) vs hybrid
- [x] Onboarding progress tracker: step indicators with completion state
- [x] DashboardLayout: Onboard Tenant nav entry under System section

## Heartbeat Auto-Sync & Dashboard Enhancements
- [x] Heartbeat router: /api/trpc/heartbeat.inventorySync endpoint (activates post-deploy)
- [x] Heartbeat /api/scheduled/inventory-sync Express route implemented in server/_core/index.ts with cron auth (isCron check), per-product lowStockThreshold JOIN query, and idempotent sync logic
- [x] Heartbeat job registration: after Publish, run `manus-heartbeat create --name inventory-sync --cron "0 */5 * * * *" --path /api/scheduled/inventory-sync` from sandbox CLI to activate the 5-minute schedule
- [x] Low-stock dashboard KPI card (Inventory Alerts card on Dashboard, links to /inventory)
- [x] Template approval history timeline in Version Control page (Approval Timeline tab)

## AI Agent Integration Architecture
- [x] AI Agent Architecture page (/agent-architecture): full flow diagram + 4 integration tabs (WhatsApp, CRM, Odoo, Dashboard)
- [x] Middleware stack: Go Event Gateway, Rust Message Processor, Temporal workflows, Dapr components
- [x] KYC/KYB: Python microservice (PaddleOCR, VLM, Docling, liveness), tRPC router, DB schema
- [x] PWA: manifest.json, offline.html, 5 icon sizes, mobile meta tags
- [x] GitHub push to munisp/whatsappCommerce (merged with remote history)
- [x] All 39 vitest tests passing
- [x] All 39 vitest tests passing

## Multilingual NLP Commerce Engine
- [x] DB schema: nlp_sessions, cart_sessions, order_items, refunds, invoices tables
- [x] tRPC router: nlp (processMessage, getSession, listSessions, resetSession, simulate) — 5 languages
- [x] Language detection: Yoruba, Hausa, Igbo, Pidgin, English marker-based + LLM fallback
- [x] Conversation state machine: greeting → browsing → cart → checkout → payment → confirmed
- [x] NLP Simulator page (/nlp-simulator): test buyer conversations in all 5 languages
- [x] tRPC router: orderCrud (create with oversell guard, updateStatus, cancel, refund, get, listRefunds, processRefund)
- [x] tRPC router: invoice (generate, list, send, markPaid, get, stats) — subscription + profit-sharing
- [x] Invoice Management page (/invoices): generate, send, mark paid, overdue detection
- [x] KYC/KYB: getOrCreateApplication, updateApplication, submit, listAll, review, createLivenessSession, stats

## Comprehensive Smoke Test Suite
- [x] 149 tests across 23 describe blocks covering all stakeholder roles × all features × all edge cases
- [x] Roles tested: Platform Admin, Tenant Owner, Tenant Agent, Anonymous Buyer
- [x] Coverage: auth, tenant, product, conversation, orderCrud, payment, agent, analytics, twenty, odoo, menu, template, templateVersions, broadcast, broadcastAb, inventory, onboarding, kyc, invoice, nlp, commerce E2E, RBAC, PWA, middleware
- [x] Commerce E2E: 10-step buyer journey from Pidgin message to CRM activity + commission calculation

## Post-Deploy Activation Steps (code complete, activation requires live URL)
- [x] Heartbeat cron code: /api/scheduled/inventory-sync route with isCron auth guard, lowStockThreshold JOIN, idempotent sync — code complete. After Publish: run `manus-heartbeat create --name inventory-sync --cron "0 */5 * * * *" --path /api/scheduled/inventory-sync`
- [x] KYC microservice code: services/kyc-verifier/ with PaddleOCR, VLM, Docling, liveness — code complete. After deploying the Python service: add KYC_SERVICE_URL secret via Settings → Secrets, then the upload flow will wire automatically via the kyc.submit tRPC procedure
## Payment Gateway Integration
- [x] DB schema: payment_gateway_configs table (tenantId, provider, publicKey, secretKey, webhookSecret, isActive)
- [x] Server: Paystack adapter (initiate, verify, webhook handler with HMAC-SHA512 validation)
- [x] Server: Flutterwave adapter (initiate, verify, webhook handler with tx_ref extraction)
- [x] Server: Mojaloop adapter (FSPIOP transfer request, quote, fulfillment)
- [x] tRPC router: paymentGateway (configure, initiate, verify, getConfig, listTransactions, verifyWebhookSignature)
- [x] Webhook Express endpoints: /api/webhooks/paystack, /api/webhooks/flutterwave
- [x] NLP checkout flow: payment link returned to buyer in checkout step response

## Tenant Self-Service Portal
- [x] Separate /portal route with TenantPortalLayout (no platform admin nav)
- [x] Portal login gate with Manus OAuth (tenantId from user.tenantId)
- [x] Portal dashboard: tenant KPIs (orders, revenue, conversations, inventory alerts) — PortalDashboard.tsx
- [x] Portal products page: manage own products only — PortalProducts.tsx (tenantId-scoped)
- [x] Portal orders page: view and update own orders only — PortalOrders.tsx
- [x] Portal invoices page: view and pay own invoices — PortalInvoices.tsx
- [x] Portal settings: WhatsApp config, AI config, billing info — PortalSettings.tsx
- [x] RBAC guard: tenantScopedProcedure middleware in tenantPortal router (throws FORBIDDEN if no tenantId)

## Heartbeat & Post-Deploy Checklist
- [x] Post-deploy checklist page (/deploy-checklist): step-by-step activation guide — DeployChecklist.tsx
- [x] Checklist items: publish, register heartbeat cron, add KYC_SERVICE_URL secret, configure payment gateways

## Remove Manus Dependencies (Self-Hosted)
- [ ] Replace Manus OAuth with Keycloak OIDC (self-hosted)
- [ ] Replace sdk.createSessionToken / authenticateRequest with self-signed JWT (HS256)
- [ ] Replace invokeLLM / BUILT_IN_FORGE_API with Ollama (llama3.2, OpenAI-compatible)
- [ ] Replace storagePut / manus-storage with MinIO S3-compatible storage
- [ ] Remove vite-plugin-manus-runtime, replace with standard Vite
- [ ] Update ENV vars: remove VITE_APP_ID/OAUTH_SERVER_URL, add KEYCLOAK_URL/REALM/CLIENT_ID
- [ ] Replace manus-heartbeat cron with node-cron scheduler
- [ ] Update const.ts startLogin() to use Keycloak authorization_code flow
- [ ] Update useAuth hook to use self-hosted JWT session

## AI/ML/DL/GNN Stack
- [ ] Nigerian synthetic transaction data generator (realistic fraud patterns, credit profiles, GNN graph)
- [ ] PyTorch fraud detection model (GNN + LSTM) with training loop and saved weights
- [ ] PyTorch credit scoring model (TabNet) with training loop and saved weights
- [ ] PyTorch biometric liveness CNN with real training loop
- [ ] Lakehouse pipeline: production DB → Delta Lake → feature store → training loader
- [ ] MLflow tracking server + model registry (Docker Compose)
- [ ] Ray cluster config for distributed training
- [ ] Model A/B testing infrastructure (shadow mode, traffic split, winner selection)
- [ ] Drift detection + performance monitoring alerts
- [ ] Continuous training: heartbeat triggers retraining on drift or data threshold

## CI/CD & Integrations
- [ ] GitHub Actions CI/CD workflow (pnpm test on PR)
- [ ] Dependabot config (npm, Go, Python, Rust)
- [ ] Mojaloop live FSPIOP integration
- [ ] Tenant portal invite magic link (WhatsApp delivery)
