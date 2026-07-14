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
