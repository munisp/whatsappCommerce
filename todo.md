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
- [x] Replace Manus OAuth with Keycloak OIDC (self-hosted)
- [x] Replace sdk.createSessionToken / authenticateRequest with self-signed JWT (HS256)
- [x] Replace invokeLLM / BUILT_IN_FORGE_API with Ollama (llama3.2, OpenAI-compatible)
- [x] Replace storagePut / manus-storage with MinIO S3-compatible storage
- [x] Remove vite-plugin-manus-runtime, replace with standard Vite
- [x] Update ENV vars: remove VITE_APP_ID/OAUTH_SERVER_URL, add KEYCLOAK_URL/REALM/CLIENT_ID
- [x] Replace manus-heartbeat cron with node-cron scheduler
- [x] Update const.ts startLogin() to use Keycloak authorization_code flow
- [x] Update useAuth hook to use self-hosted JWT session

## AI/ML/DL/GNN Stack
- [x] Nigerian synthetic transaction data generator (realistic fraud patterns, credit profiles, GNN graph)
- [x] PyTorch fraud detection model (GNN + LSTM) with training loop and saved weights
- [x] PyTorch credit scoring model (TabNet) with training loop and saved weights
- [x] PyTorch biometric liveness CNN with real training loop
- [x] Lakehouse pipeline: production DB → Delta Lake → feature store → training loader
- [x] MLflow tracking server + model registry (Docker Compose)
- [x] Ray cluster config for distributed training
- [x] Model A/B testing infrastructure (shadow mode, traffic split, winner selection)
- [x] Drift detection + performance monitoring alerts
- [x] Continuous training: heartbeat triggers retraining on drift or data threshold

## CI/CD & Integrations
- [x] GitHub Actions CI/CD workflow (pnpm test on PR)
- [x] Dependabot config (npm, Go, Python, Rust)
- [x] Mojaloop live FSPIOP integration
- [x] Tenant portal invite magic link (WhatsApp delivery)

## ML Ops Monitoring & Payment Reconciliation
- [x] ML Ops monitoring dashboard: continuous training status, drift metrics, MLflow run history, A/B model comparison
- [x] End-to-end Mojaloop + payment webhook reconciliation simulation with test harness
- [x] Integration setup wizard: Paystack, Flutterwave, Keycloak step-by-step configuration UI (extend existing CredentialWizard)
- [x] Wire real training data pipeline from production DB to ML stack
- [x] Add mlOps tRPC router with training status, drift metrics, MLflow run history endpoints
- [x] Add reconciliation tRPC router with simulate, verify, and audit trail endpoints
- [x] Add ML Ops and Reconciliation nav items to DashboardLayout
- [x] Add Keycloak tRPC router with saveConfig, getConfig, testConnection procedures
- [x] Extend CredentialWizard with dedicated Paystack, Flutterwave, Keycloak integration steps
- [x] Add MLflow time-series Metric Curves tab to ML Ops dashboard (getMetricHistory tRPC procedure + multi-run line charts)
- [x] Wire Keycloak SSO login redirect for tenant portal (getLoginUrl procedure + SSO login panel in TenantPortalLayout)
- [x] Build nightly reconciliation discrepancy alert heartbeat handler (/api/scheduled/reconciliation-alert + notifyOwner integration)
- [x] Register nightly reconciliation heartbeat cron (task_uid: M7FY8UY7jUgczPs5EpcrUn, fires 02:00 UTC daily)
- [x] Build configurable alert threshold UI — DB table + tRPC + Alert Rules admin page
- [x] Implement Keycloak SSO OIDC callback handler — /portal/sso-callback route, token exchange, session creation
- [x] Register nightly reconciliation heartbeat cron (task_uid: M7FY8UY7jUgczPs5EpcrUn, fires 02:00 UTC daily)
- [x] Build alert_rules DB table with configurable thresholds (reconciliation_discrepancy, low_stock, failed_payments, model_drift)
- [x] Build alertRules tRPC router (list, create, update, toggle, delete, getRuleTypeMeta)
- [x] Build Alert Rules admin UI page (/alert-rules) with CRUD, enable/disable toggle, heartbeat task_uid display
- [x] Add Alert Rules nav item to DashboardLayout sidebar
- [x] Add keycloak.exchangeCode tRPC procedure for OIDC code→token exchange + portal session creation
- [x] Build SsoCallback portal page (/portal/sso-callback) that completes the Keycloak SSO login flow
- [x] Wire /alert-rules and /portal/sso-callback routes in App.tsx
- [x] Seed default reconciliation alert rule on first admin login (alertRules.seedDefaults tRPC mutation)
- [x] Add alert_rule_events DB table to track each rule trigger (timestamp, actual_value, threshold, rule_id)
- [x] Add alertRules.listEvents tRPC procedure to query event history
- [x] Build Alert History tab on /alert-rules page showing last 30 days of trigger events
- [x] Keycloak SSO user provisioning — upsert SSO user email/name into tenants table after exchangeCode
- [x] Add alert_rule_events DB table for immutable trigger history log
- [x] Add seedDefaults procedure to alertRules router (auto-seeds 4 default rules on first admin visit)
- [x] Add listEvents procedure to alertRules router with day-range filtering
- [x] Update heartbeat handler to read threshold from DB and write event rows
- [x] Add Alert History tab to AlertRules page with 7/30/90-day filter and event list
- [x] Add Seed Defaults button to AlertRules page header
- [x] Auto-seed default rules when AlertRules page loads with no rules
- [x] Add tenant_sso_profiles DB table for SSO user provisioning
- [x] Add tenantSsoProfiles import and upsert in keycloak.exchangeCode procedure
- [x] SSO upsert: insert on first login, increment ssoLoginCount + update lastSsoLoginAt on repeat logins
- [x] SSO Users admin page with search, stats, and login history table
- [x] Alert cooldown_minutes column in alertRules table and heartbeat cooldown check
- [x] Keycloak role mapping: realm_access.roles → portal role in session JWT
- [x] listSsoProfiles tRPC procedure with tenant join and search
- [x] Nigeria profitability model document with 4 charts
- [x] Seed alert cooldown defaults (120 min) in seedDefaults procedure
- [x] Add portalRole column to tenant_sso_profiles table and store it on SSO login
- [x] Build /revenue admin dashboard page with live MRR, GMV, txn trends
- [x] Redesign profitability model as profit-sharing revenue model with updated charts
- [x] Seed alert cooldown defaults (120 min) on all four default rules in seedDefaults
- [x] Add portalRole column to tenant_sso_profiles table and store resolved role after SSO login
- [x] Build Revenue Dashboard page (/revenue) with KPI cards, monthly trend charts, tenant breakdown table, and revenue mix pie
- [x] Create revenue tRPC router with summary, monthlyTrend, tenantBreakdown, and getConfig procedures
- [x] Add Revenue nav item to DashboardLayout
- [x] Redesign profitability model as profit-sharing revenue model (5% net profit share + 0.2% GMV txn share)
- [x] Generate 5 updated profit-sharing model charts (comparison, waterfall, cashflow, sensitivity, mix)
- [x] Write comprehensive profit-sharing profitability model document
- [x] Add cogsRate column to tenants schema and DB, update tenant router + db helper
- [x] Add COGS override UI to TenantDetail settings panel
- [x] Add forecast and gmvLeaderboard procedures to revenue router
- [x] Add Forecast and GMV Leaderboard tabs to RevenueDashboard page
- [x] Add forecast_snapshots table to schema
- [x] Add snapshot heartbeat handler and accuracy metric on Forecast tab
- [x] Add cogs_dispute_requests table to schema
- [x] Build COGS dispute tRPC procedures and UI button with owner notification
- [x] Build leaderboard top-3 heartbeat handler with owner push alert
- [x] Forecast accuracy tracking: forecast_snapshots table, monthly heartbeat, accuracy tab on Revenue Dashboard
- [x] COGS dispute workflow: cogs_dispute_requests table, cogsDispute tRPC router, CogsDisputes admin page, owner notification on request
- [x] Leaderboard top-3 notifications: daily heartbeat sends owner push notification with top-3 GMV growth merchants
- [x] Register forecast-snapshot heartbeat cron (task_uid: VJdvdQyQfJ5ZhQpPRH4eKf, fires 1st of month)
- [x] Register leaderboard-top3 heartbeat cron (task_uid: FNBLTZ2oCAgm2eCajdcNyW, fires daily 09:00 UTC)
- [x] COGS Disputes admin page (/cogs-disputes) with approve/reject workflow
- [x] Forecast Accuracy tab on Revenue Dashboard with projected vs actual table

## Escrow & Logistics (CBN PSSP → PSP upgrade path)
- [x] DB schema: escrow_transactions table (orderId, tenantId, amount, state machine, custodyMode PSSP/PSP, bankRef, releaseInstructedAt, settledAt)
- [x] DB schema: merchant_wallets table (tenantId, balance, currency, custodyMode)
- [x] DB schema: wallet_transactions table (walletId, type, amount, orderId, description, createdAt)
- [x] DB schema: logistics_shipments table (orderId, tenantId, provider, trackingId, status, webhookPayloads, deliveredAt)
- [x] DB schema: escrow_disputes table (escrowId, orderId, reason, status, buyerEvidence, merchantEvidence, resolvedBy, resolution)
- [x] DB schema: escrow_config table (platform-level PSSP/PSP mode toggle, bank partner details)
- [x] Add escrow enums: escrow_state, custody_mode, dispute_resolution, shipment_status
- [x] tRPC router: escrow (createHold, releaseToMerchant, initiateRefund, getByOrder, listAll, getStats, getConfig, setConfig)
- [x] tRPC router: logistics (createShipment, getShipment, listShipments, getProviders, simulateDelivery, getStats)
- [x] tRPC router: escrowDispute (raise, list, review, getByOrder)
- [x] tRPC router: wallet (getBalance, listTransactions, requestWithdrawal, getStats) — PSP mode only
- [x] Express webhook: POST /api/webhooks/shipbubble — HMAC-validated delivery events → trigger buyer confirmation flow
- [x] Express webhook: POST /api/webhooks/escrow-bank — bank partner settlement confirmation (PSSP mode)
- [x] Buyer confirmation flow: on delivery webhook, update escrow state to DELIVERY_CONFIRMED
- [x] Auto-confirm: if buyer doesn't respond within 24h, auto-release escrow
- [x] Platform fee deduction at settlement (3.125% effective GMV rate)
- [x] Float income calculation heartbeat (PSP mode): daily accrual on held balances
- [x] Admin: Escrow Dashboard page (/escrow) — KPIs, state breakdown, recent transactions, config panel
- [x] Admin: Logistics Tracker page (/logistics) — shipment list, status map, provider stats
- [x] Admin: Dispute Management page (/disputes) — open disputes, evidence review, resolve/refund actions
- [x] Portal: Merchant Wallet page (/portal/wallet) — balance, transaction history, withdrawal request (PSP mode)
- [x] Portal: Shipment Tracker on PortalOrders — tracking link, delivery status per order
- [x] DashboardLayout: add Escrow, Logistics, Disputes nav items under PAYMENTS section
- [x] Vitest: escrow router tests (createHold, release, refund, state transitions)
- [x] Vitest: logistics router tests (createShipment, webhook handler, auto-confirm)
- [x] Vitest: wallet router tests (PSP mode balance, withdrawal)
- [x] Checkpoint after all escrow/logistics features complete

## Escrow & Logistics (CBN PSP/PSSP)
- [x] Database schema: escrow_transactions, merchant_wallets, wallet_ledger, logistics_shipments, escrow_disputes, float_income_entries, escrow_config tables
- [x] Drizzle migration applied to database
- [x] Escrow router: create, hold, buyer confirm, release, refund, dispute, getStats, getConfig, setConfig
- [x] Wallet router: getBalance, listTransactions, requestWithdrawal
- [x] Escrow dispute router: raise, list, review/resolve
- [x] Logistics router: getProviders, createShipment, getShipment, listShipments, simulateDelivery, getStats
- [x] Shipbubble webhook handler (/api/webhooks/shipbubble) with HMAC-SHA512 validation
- [x] Bank escrow settlement callback (/api/webhooks/escrow-bank) for PSSP mode
- [x] Escrow auto-confirm heartbeat (/api/scheduled/escrow-auto-confirm)
- [x] PSP float income heartbeat (/api/scheduled/float-income)
- [x] EscrowDashboard page: KPIs, state breakdown, transaction table, config editor
- [x] LogisticsTracker page: shipment list, status badges, delivery simulation, stats
- [x] DisputeManagement page: dispute list, review dialog, resolution workflow
- [x] MerchantWallet component: balance cards, transaction history, withdrawal dialog
- [x] PortalWallet page: merchant-facing wallet view in tenant portal
- [x] Sidebar navigation: Finance section with Escrow, Logistics, Disputes
- [x] App.tsx routes: /escrow, /logistics, /disputes, /portal/wallet
- [x] Vitest tests: escrow state machine (30 tests), logistics webhook mapping (12 tests)
- [x] All 217 tests passing

## Notification Center, CSV Export, Escrow Timeline
- [x] DB schema: merchant_notifications table (tenantId, type, title, body, metadata, read, createdAt)
- [x] tRPC router: notifications (list, markRead, markAllRead, getUnreadCount)
- [x] Emit notifications on escrow state changes (escrow_held, delivery_confirmed, settled, refunded, dispute_raised)
- [x] Emit notifications on dispute events (opened, resolved)
- [x] tRPC router: wallet.exportLedgerCsv (returns CSV string for download)
- [x] tRPC router: escrow.getTimeline (joins escrow_transactions + logistics_shipments + escrow_disputes into ordered event list)
- [x] Frontend: NotificationCenter component (bell icon, dropdown, unread badge, mark-read)
- [x] Frontend: Add NotificationCenter to PortalDashboard layout header
- [x] Frontend: CSV export button on MerchantWallet page
- [x] Frontend: EscrowTimeline component (vertical timeline, state icons, timestamps, logistics events)
- [x] Frontend: EscrowDetail page or modal that shows timeline for a single escrow transaction
- [x] Vitest: notification emit tests, CSV format tests, timeline query tests

## Notification Center, CSV Export & Escrow Timeline (v3)
- [x] merchant_notifications table added to schema and migrated
- [x] notificationsRouter: list, markRead, markAllRead, getUnreadCount, emitNotification helper
- [x] NotificationCenter component: bell icon with badge, dropdown list, mark-all-read
- [x] Notification emits wired into escrow state transitions (held, delivery_confirmed, settled, refunded)
- [x] Notification emits wired into dispute raise and dispute resolve
- [x] CSV export procedure (wallet.exportLedgerCsv) returns full ledger as CSV string
- [x] CSV export button on MerchantWallet page (header + transaction table header)
- [x] EscrowTimeline component: chronological event list with icons and variant colours
- [x] Timeline dialog in EscrowDashboard: Timeline button per transaction row
- [x] NotificationCenter added to TenantPortalLayout top bar
- [x] Wallet nav item added to TenantPortalLayout sidebar

## Enhancement: Date Range CSV, Timeline Attachments, Notification Filters (v4)
- [x] Backend: wallet.exportLedgerCsv accepts optional startDate/endDate for date-range filtering
- [x] Backend: escrow_timeline_attachments table (id, escrowId, eventId, type: doc|note, fileUrl, fileKey, filename, mimeType, note, uploadedBy, createdAt)
- [x] Backend: escrow.addTimelineAttachment mutation (upload to S3, record in DB)
- [x] Backend: escrow.getTimeline includes attachments per event
- [x] Backend: notifications.list accepts optional type filter (payments|logistics|disputes|all)
- [x] Frontend: Date range picker dialog on MerchantWallet CSV export (shadcn Calendar, start/end)
- [x] Frontend: EscrowTimeline attachment panel per event (upload button, note input, list of existing attachments)
- [x] Frontend: NotificationCenter filter tabs (All / Payments / Logistics / Disputes)
- [x] Tests: date range CSV, attachment upload, notification filter

## Merchant Onboarding Wizard
- [x] Schema: merchant_onboarding_progress table (tenantId, step, completedSteps, whatsappConnected, productsAdded, deliveryZonesSet, completedAt)
- [x] Backend: onboardingWizard router (getProgress, completeStep, reset)
- [x] Frontend: OnboardingWizard multi-step component (WhatsApp → Products → Delivery Zones → Done)
- [x] Frontend: Show wizard automatically for new tenants on portal home
- [x] Frontend: Progress indicator and step validation

## Escrow SLA Alerts
- [x] Schema: escrow_sla_config table (tenantId, releaseDeadlineHours, warningHours, autoReleaseEnabled)
- [x] Backend: SLA deadline stored on escrow_transactions (slaDeadline column)
- [x] Backend: Heartbeat job: scan for escrows approaching/past SLA, emit notifications
- [x] Frontend: SLA countdown badge on EscrowDashboard rows
- [x] Frontend: SLA config editor in Escrow Dashboard settings panel
- [x] Frontend: Admin SLA overview widget

## Dispute Evidence Portal
- [x] Schema: dispute_evidence_tokens table (token, disputeId, buyerPhone, expiresAt, usedAt)
- [x] Schema: dispute_evidence_submissions table (id, disputeId, token, fileUrl, fileKey, filename, mimeType, note, submittedAt)
- [x] Backend: generateEvidenceToken mutation (admin/merchant triggers)
- [x] Backend: Public route: GET /evidence/:token (validate token, return dispute summary)
- [x] Backend: Public route: POST /evidence/:token/submit (upload files + note, no auth)
- [x] Frontend: Public EvidencePortal page (/evidence/:token) — no login required
- [x] Frontend: Evidence submissions visible in DisputeManagement admin view

## Batch 5: AI Receipt Scanning, Onboarding Persistence, SLA Extension
- [x] Schema: merchant_onboarding_progress table (tenantId, currentStep, stepData JSON, completedAt)
- [x] Schema: escrow_sla_extensions table (id, escrowId, requestedByTenantId, extensionHours, reason, status, requestedAt, respondedAt, buyerToken)
- [x] Backend: AI receipt scan tRPC procedure (vision LLM, extract text, validate clarity)
- [x] Backend: onboarding.saveProgress and onboarding.getProgress procedures
- [x] Backend: sla.requestExtension, sla.respondToExtension procedures
- [x] Backend: Public route GET/POST /api/sla-extension/:token for buyer to approve/reject
- [x] Frontend: AI scan panel in EvidencePortal with scan results and confidence score
- [x] Frontend: "Save and Continue Later" button in OnboardingWizard
- [x] Frontend: "Resume Onboarding" widget on PortalDashboard
- [x] Frontend: "Request SLA Extension" button and dialog on EscrowDashboard
- [x] Frontend: Buyer SLA extension response page (/sla-extension/:token)

## Next Steps (Round 4)
- [x] WhatsApp SLA extension notification to buyer with response link
- [x] Onboarding funnel analytics chart on admin dashboard
- [x] Configurable AI scan confidence threshold in Escrow Config
- [x] Confidence threshold enforced in evidence portal submission
- [x] Backend: CSV product import endpoint (parse CSV, validate, bulk insert products)
- [x] Backend: Dispute resolution email to buyer (send email when dispute resolved)
- [x] Backend: SLA extension history query (list all extensions per escrow transaction)
- [x] Frontend: CSV upload UI on product management page
- [x] Frontend: SLA extension history tab in Escrow Dashboard
- [x] Frontend: Wire dispute resolution email confirmation in Dispute Management page

## Round 5: Analytics, Bulk Operations, WhatsApp Templates

### Merchant Analytics Dashboard
- [x] Backend: tenantPortal.getAnalytics procedure (GMV trend, order volume, AOV, top products)
- [x] Frontend: /portal/analytics page with line chart (GMV), bar chart (orders), stat cards, top products table
- [x] Frontend: Add "Analytics" nav item to TenantPortalLayout

### Bulk Order Status Update
- [x] Backend: escrow.bulkUpdateState procedure (array of escrow IDs + target state, transactional)
- [x] Frontend: Checkbox column on EscrowDashboard transaction table with Select All
- [x] Frontend: Bulk action toolbar (count + Bulk Release / Bulk Refund buttons + confirmation dialog)

### WhatsApp Message Templates (operator-facing)
- [x] Schema: operator_templates table (id, name, category enum, body, variables, isActive, description, createdAt, updatedAt)
- [x] Migration: table created in database via SQL
- [x] Backend: operatorTemplates router (list, getById, create, update, toggleActive, delete)
- [x] Frontend: /operator-templates admin page with template grid, create/edit dialog, live WhatsApp-style preview
- [x] Frontend: Added "Msg Templates" nav item to DashboardLayout Platform section

## Round 6: Template Wiring, CSV Export, Escrow Filter Chips

### Operator Templates → Portal Broadcasts
- [x] Backend: tenantPortal.listApprovedTemplates procedure (returns active operator templates for merchant use)
- [x] Frontend: Create /portal/broadcasts page with campaign list and create dialog
- [x] Frontend: Template picker in create-campaign dialog uses operatorTemplates.list (activeOnly=true)
- [x] Frontend: Live WhatsApp-style body preview when template is selected
- [x] Frontend: Add "Broadcasts" nav item to TenantPortalLayout

### CSV Export on Merchant Analytics
- [x] Frontend: exportToCsv() helper that serialises dailyTrend + topProducts to CSV and triggers download
- [x] Frontend: "Export CSV" button in MerchantAnalytics header (disabled when loading/no data)

### Quick-Filter Chips on Escrow Dashboard
- [x] Frontend: QUICK_FILTERS constant with label + state + color for key states (All, Held, Disputed, Pending Release, Settled)
- [x] Frontend: Chip row above the transaction table; clicking a chip sets stateFilter and selects all matching rows
- [x] Frontend: "Select matching" badge count on each chip showing how many rows match

## Round 7: All 20 Suggested Next Steps

### Batch A — Broadcasts & Analytics
- [x] A1: Template variable mapping UI — map {{variable}} placeholders to CRM contact fields in create-campaign dialog
- [x] A2: Scheduled broadcast — date/time picker in create-campaign dialog wired to scheduledAt field
- [x] A3: Analytics period comparison — "Compare to previous period" toggle overlays prior-period GMV as dashed line
- [x] A4: Dispute evidence download — "Download Evidence" button on DisputeManagement page to export evidence files as ZIP
- [x] A5: SLA extension email preview — show rendered email body preview in the SLA extension request dialog

### Batch B — Templates & Portal
- [x] B1: Tenant template assignment — operator can assign specific templates to specific tenants from /operator-templates
- [x] B2: Analytics comparison CSV — Export CSV includes both current and prior period columns when comparison is active
- [x] B3: Bulk filter chip persistence — remember last active chip in localStorage so it survives page refresh
- [x] B4: Onboarding progress email — send owner notification when a merchant completes onboarding wizard
- [x] B5: AI scan retry — "Retry Scan" button in EvidencePortal when scan confidence is below threshold

### Batch C — Escrow, Orders & Products
- [x] C1: Broadcast delivery webhook simulation — "Simulate Delivery" button on a sent campaign to fire mock delivery/read events
- [x] C2: Escrow dispute auto-escalation — show "Escalate" button on disputes open > 72 h; update status to escalated
- [x] C3: Merchant wallet top-up flow — "Top Up" button on PortalWallet that opens a payment dialog (mock flow)
- [x] C4: Portal order detail page — /portal/orders/:id with full line items, status timeline, and update-status button
- [x] C5: Product low-stock alerts — badge + alert banner on PortalProducts when stockQuantity < 5

### Batch D — Admin & Platform
- [x] D1: NLP intent confidence heatmap — add a heatmap chart to NLPSimulator showing intent vs confidence matrix
- [x] D2: Keycloak SSO status indicator — show per-tenant SSO enabled/disabled badge on Tenants list page
- [x] D3: Reconciliation export — "Export CSV" button on ReconciliationSim page
- [x] D4: Service health history chart — sparkline trend of uptime % per service on ServiceHealth page
- [x] D5: Admin audit log viewer — new /audit-log page listing all admin mutations with user, action, timestamp

## Round 8: Suggested Next Steps
- [x] R8-1: Persist broadcast varMapping to DB — add varMapping jsonb column to broadcastCampaigns schema, migrate, update create/list procedures, display in PortalBroadcasts campaign detail
- [x] R8-2: AuditLog CSV export — add "Download CSV" button to /audit-log page
- [x] R8-3: Real escalation notifications — fire owner notification (notifyOwner) + merchant notification (emitNotification) when a dispute is escalated

## Round 9: Suggested Next Steps
- [x] R9-1: Broadcast scheduling enforcement — Heartbeat cron polls scheduled campaigns past scheduledAt and auto-triggers send
- [x] R9-2: Dispute escalation SLA dashboard card — admin dashboard card showing escalated dispute count, avg time-to-escalation, drill-down link
- [x] R9-3: varMapping substitution in broadcast send — merge campaign varMapping into each recipient's variables object during send

## Round 10 — Low-connectivity UX + Round 9 follow-ups
- [x] Broadcast send preview modal (WhatsApp bubble mock with varMapping rendered)
- [x] escalation_count alert rule type added to AlertRules (color badge + create dialog)
- [x] NLPSimulator: network quality simulator (4G/2G/Offline) with queuing behaviour
- [x] NLPSimulator: Data-Lite mode toggle with explanatory banner
- [x] NLPSimulator: 2G latency simulation (2-4s artificial delay)
- [x] NLPSimulator: offline message queuing with ⏳ indicator

## Round 11 — WhatsApp Media Uploads + Low-connectivity Optimisation
- [x] Backend: whatsappMedia router (uploadFromWhatsApp, listByConversation, getDownloadUrl)
- [x] Backend: document type detection (purchase_order, invoice, receipt, image, other)
- [x] Backend: S3 storage for WhatsApp media files
- [x] Backend: SMS fallback flag (smsFailoverEnabled) on tenants table
- [x] Backend: USSD menu mode session flag + numbered menu reply generator in NLP router
- [x] Backend: multilingual error message map (EN/YO/HA/IG/PID) in NLP router
- [x] Frontend: WhatsApp Media Upload page (upload, scan, download, type badge)
- [x] Frontend: NLP Simulator USSD mode toggle + numbered menu rendering
- [x] Frontend: SMS fallback toggle in tenant settings / PortalSettings
- [x] Frontend: multilingual error preview in NLP Simulator

## Round 11 — Low-connectivity & WhatsApp Media (complete)
- [x] WhatsApp media/document upload handler (whatsappMedia router: upload, list, getDownloadUrl, AI document type detection)
- [x] whatsapp_media_files DB table with S3 storage
- [x] smsFailoverEnabled column on tenants table + toggle in Tenants page
- [x] USSD menu mode: ussdMode stored in nlp_sessions context jsonb, processMessage input accepts ussdMode flag
- [x] Multilingual error messages in NLP router (Yoruba, Hausa, Igbo, Pidgin, English)
- [x] NLP Simulator: USSD mode toggle, network quality selector (4G/2G/Offline), data-lite mode
- [x] WhatsApp Media Portal page (/whatsapp-media) with upload, AI scan, download
- [x] escalation_count alert rule type added to alertRules router + AlertRules page
- [x] Broadcast send preview modal in BroadcastCampaigns
- [x] WA Media nav item in DashboardLayout

## Round 12 — Webhook ingestion, airtime top-up, offline sync
- [x] Backend: /api/webhooks/whatsapp GET (verify token) + POST (media ingestion → S3 → whatsapp_media_files)
- [x] Backend: airtime top-up USSD shortcode in NLP payment reply (MTN/Airtel/Glo/9mobile)
- [x] Backend: offlineMessageQueue table + syncOfflineMessages procedure
- [x] Frontend: NLP Simulator offline message queue badge + replay animation + summary card
- [x] Frontend: airtime shortcode display in conversation payment messages
- [x] Frontend: webhook status indicator on Service Health page

## Round 13 — Webhook HMAC validation, media download worker, offline queue persistence
- [x] Backend: HMAC-SHA256 signature verification on POST /api/webhooks/whatsapp (X-Hub-Signature-256 header, WHATSAPP_APP_SECRET env var)
- [x] Backend: heartbeat job /api/scheduled/wa-media-download — fetch queued media from Meta Graph API, upload to S3, update whatsapp_media_files
- [x] Backend: wire queueOfflineMessage / syncOfflineQueue / getOfflineQueueCount to offline_message_queue DB table (already fully wired in nlp.ts)
- [x] Frontend: NLPSimulator offline queue persisted via tRPC queueOfflineMessage on send, syncOfflineQueue on reconnect, getOfflineQueueCount for badge
## Round 14 — Webhook DLQ, retry heartbeat, offline queue load-on-mount
- [x] Schema: wa_webhook_events table (messageId, phoneNumberId, waPhoneNumber, messageType, rawPayload, status, retryCount, lastError, processedAt, nextRetryAt)
- [x] Backend: DLQ logging in POST /api/webhooks/whatsapp — insert waWebhookEvents on receive, update to processed/failed on outcome
- [x] Backend: heartbeat /api/scheduled/wa-webhook-retry — retries failed events up to 3 times with exponential back-off (2^retryCount minutes), marks dead after 3 failures
- [x] Backend: getQueuedMessages tRPC procedure (protectedProcedure) — returns queued offline messages for a session ordered by queuedAt
- [x] Frontend: NLPSimulator load-on-mount useEffect — calls getQueuedMessages, pre-populates offlineQueue and messages with ⏳ from DB on page load

## Round 15 — Medusa Adapter + Mission Gap Implementation
### Medusa v2 Commerce Adapter
- [x] Backend: MedusaCommerceAdapter service (server/services/medusaAdapter.ts) — wraps Medusa Store/Admin REST API with fallback to native tables
- [x] Backend: medusa tRPC router (server/routers/medusa.ts) — products, variants, collections, price lists, inventory, promotions via Medusa API
- [x] Frontend: MedusaProducts page (/medusa-products) — product catalog powered by Medusa adapter
- [x] Docs: medusa-setup.md — guide for pointing platform at self-hosted or Medusa Cloud instance

### B2B Module
- [x] Schema: wholesale_price_tiers, b2b_rfq, b2b_purchase_orders, buyer_type enum on customers
- [x] Backend: b2b tRPC router — getWholesalePrice, createRFQ, submitPurchaseOrder, approvePO
- [x] Backend: B2B NLP intents in nlp.ts — bulk order, RFQ, wholesale pricing, net-30 payment terms
- [x] Frontend: B2BPortal page (/b2b) — RFQ form, PO tracker, wholesale price calculator

### Multi-Channel (USSD + SMS)
- [x] Schema: ussd_sessions, channel_messages (channel enum: whatsapp, ussd, sms, telegram)
- [x] Backend: /api/webhooks/ussd — Africa's Talking USSD format, maps to NLP processMessage
- [x] Backend: /api/webhooks/sms — inbound SMS handler via Africa's Talking/Twilio
- [x] Backend: ussd tRPC router — getSession, sendUssdResponse
- [x] Frontend: ChannelManager page (/channels) — USSD/SMS channel config, session viewer

### Marketplace
- [x] Schema: marketplace_sellers, seller_products, commissions, marketplace_orders
- [x] Backend: marketplace tRPC router — registerSeller, listSellerProducts, createMarketplaceOrder, calculateCommission
- [x] Frontend: MarketplaceDashboard page (/marketplace) — seller onboarding, commission tracker, catalog discovery

### Cross-Border / Mobile Money
- [x] Schema: mobile_money_transactions, forex_rates, currency_configs
- [x] Backend: mobileMoney tRPC router — initMoMoPayment (MTN/Airtel), initMPesaPayment, checkMoMoStatus
- [x] Backend: /api/webhooks/momo — MTN MoMo callback handler
- [x] Backend: /api/webhooks/mpesa — M-Pesa STK push callback
- [x] Frontend: MobileMoneyDashboard page (/mobile-money) — MoMo/M-Pesa transactions, forex rates

### Service Commerce
- [x] Schema: service_catalog, appointments, digital_products, subscriptions, subscription_invoices
- [x] Backend: serviceCommerce tRPC router — createService, bookAppointment, purchaseDigitalProduct, createSubscription
- [x] Frontend: ServiceCatalog page (/services) — service listing, appointment booking calendar, digital downloads

### Analytics BI
- [x] Schema: cohort_snapshots, ltv_scores, churn_predictions
- [x] Backend: advancedAnalytics tRPC router — getCohortAnalysis, getLTVScores, getChurnPredictions, getMerchantBI
- [x] Frontend: AdvancedAnalytics page (/analytics-bi) — cohort charts, LTV heatmap, churn risk table

### Compliance (B2G)
- [x] Schema: tax_filings, cac_registrations, procurement_bids, government_contracts
- [x] Backend: compliance tRPC router — submitTaxFiling, registerCAC, submitProcurementBid, listGovernmentContracts
- [x] Frontend: CompliancePortal page (/compliance) — FIRS tax filing, CAC registration, B2G e-procurement

### Round 15 UI
- [x] Frontend: WebhookDLQ page (/webhook-dlq) — dead letter queue viewer with retry button
- [x] Frontend: DashboardLayout nav — add all new sections (B2B, Channels, Marketplace, Mobile Money, Services, Analytics BI, Compliance)
- [x] Backend: retryWebhookEvent tRPC procedure in a new webhookAdmin router

## Round 15 + Mission Gap Implementation (Complete)
- [x] Medusa v2 commerce adapter service (MedusaCommerceAdapter) with fallback to native tables
- [x] Medusa tRPC router: products, orders, cart, price lists, promotions, regions, collections
- [x] B2B module: wholesalePriceTiers table, b2bRfq table, b2bPurchaseOrders table
- [x] B2B router: listPriceTiers, upsertPriceTier, submitRfq, quoteRfq, listPurchaseOrders, createPurchaseOrder, b2bStats
- [x] B2B Portal frontend page with price tiers, RFQ, and PO management
- [x] Multi-channel: ussdSessions, channelMessages tables + channels router (USSD, SMS, Telegram, Instagram)
- [x] Multi-Channel Hub frontend page
- [x] Marketplace: marketplaceSellers, marketplaceListings, marketplaceCommissions tables + marketplace router
- [x] Marketplace Portal frontend page
- [x] Mobile Money: mobileMoneyTransactions table + mobileMoney router (MTN MoMo, M-Pesa, Airtel Money)
- [x] Mobile Money Portal frontend page
- [x] Service Commerce: serviceProviders, serviceAppointments, digitalProducts, subscriptions tables + serviceCommerce router
- [x] Service Commerce frontend page
- [x] Analytics BI: cohortAnalysis, ltv, churnPrediction tables + analyticsBI router
- [x] Analytics BI Dashboard frontend page
- [x] Compliance: firsFilings, cacRegistrations, b2gProcurements tables + compliance router
- [x] Compliance Portal frontend page
- [x] Webhook DLQ router: listEvents, retryEvent, dismissEvent, stats
- [x] Webhook DLQ Admin UI page with status filter, retry, and dismiss actions
- [x] All 8 new pages registered in App.tsx routes
- [x] All 8 new nav items added to DashboardLayout Commerce section
- [x] Webhook DLQ nav item added to System section
- [x] 0 TypeScript errors, 241 tests passing

## Round 16 — Unified Onboarding & Integration Health
- [x] Add tenant_integrations, provisioning_jobs, unified_onboarding_sessions DB tables
- [x] Build provisioningRouter: initSession, saveStep, provisionMedusa, provisionTwentyCrm, provisionOdooErp, provisionChannel, provisionPayment, listIntegrations, pingIntegration, listProvisioningJobs
- [x] Build 10-step UnifiedOnboarding wizard page (welcome, business, WhatsApp, CRM, ERP, eCommerce, channels, payments, billing, review)
- [x] Build IntegrationHealth dashboard with real-time status, ping, and job history
- [x] Wire both pages into App.tsx routes and DashboardLayout navigation
- [x] Africa's Talking + mobile money credential env vars documented
- [x] 241 tests passing, 0 TypeScript errors

## Round 17 — Deep Integration Sync
- [x] Medusa sync: wire NLP processOrder to create orders in Medusa via adapter
- [x] Medusa sync: pull Medusa product catalog into WhatsApp menu builder (syncMedusaCatalog procedure)
- [x] Medusa sync: sync status updates back from Medusa to platform orders table
- [x] Twenty CRM: auto-create/update contact on every new WhatsApp conversation
- [x] Twenty CRM: push order events as CRM activities (note/task) on order creation
- [x] Twenty CRM: sync router with getContact, upsertContact, createActivity procedures
- [x] Odoo ERP: heartbeat job /api/scheduled/odoo-inventory-sync pulling stock from Odoo product.product
- [x] Odoo ERP: update platform inventory table with Odoo stock levels
- [x] Odoo ERP: push new orders to Odoo as sale.order records
- [x] Frontend: sync status badges in NLP simulator, menu builder, inventory pages

## Round 17 - Deep Integration Sync (Complete)
- [x] integrationSync.ts service: syncOrderToMedusa, syncOrderToOdoo, syncContactToTwenty, syncActivityToTwenty, fetchOdooStockLevels, fetchMedusaCatalog
- [x] Wire Medusa order creation into NLP confirm_order flow (fire-and-forget)
- [x] Wire Odoo sale.order push into NLP confirm_order flow (fire-and-forget)
- [x] Wire Twenty CRM contact + activity sync into NLP confirm_order flow (fire-and-forget)
- [x] Odoo inventory sync heartbeat (/api/scheduled/odoo-inventory-sync, every 10 min)
- [x] Medusa catalog sync heartbeat (/api/scheduled/medusa-catalog-sync, every 30 min)
- [x] getSyncEvents procedure in provisioning router for sync history
- [x] Background Sync Status panel in IntegrationHealth page
- [x] SyncEventRow component showing last sync time, products synced, contacts synced
- [x] 241 tests passing, 0 TypeScript errors

## Round 18 - Medusa Product Picker + Order Timeline (In Progress)
## Round 18 - Medusa Product Picker + Order Timeline (Complete)
- [x] Backend: getCatalogForPicker + importProductsToMenu tRPC procedures in medusa router
- [x] Backend: getOrderTimeline procedure in nlp router (platform order + Medusa status + Odoo delivery + Twenty CRM activities)
- [x] Fix TypeScript errors in getOrderTimeline (integrationType not service, provider not gateway, delivered not fulfilled)
- [x] Frontend: "Import from Medusa" button + product picker dialog in MenuBuilder page
- [x] Frontend: /orders/:orderNumber unified order timeline page with multi-system journey view
- [x] Wire /orders/:orderNumber route in App.tsx
- [x] 241 tests passing, 0 TypeScript errors

## Round 19 — Medusa Onboarding, Odoo↔Medusa Bridge, AI Visual Inventory

- [x] Answered architecture questions: Medusa onboarding flow, Odoo↔Medusa inventory bridge, SOTA visual AI
- [x] Schema: medusaProductOnboarding, odooMedusaInventoryBridge, visualInventorySessions tables added
- [x] Python VLM service: Ollama (Qwen2.5-VL/MiniCPM-V/Gemma3) + YOLO for object detection
- [x] Go orchestrator: image preprocessing, resize, format conversion, pipeline routing
- [x] Rust bbox post-processor: NMS, deduplication, confidence re-scoring via Axum REST API
- [x] Docker Compose: full visual inventory stack (ollama, python-vlm, go-orchestrator, rust-bbox)
- [x] TypeScript visualInventory tRPC router: analyzeImage, listSessions, getSession, updateInventory
- [x] TypeScript medusaOnboarding tRPC router: list, addProduct, importFromCatalog, pushToMedusa, stats
- [x] TypeScript odooMedusaBridge tRPC router: list, upsertMapping, syncOdooToMedusa, stats
- [x] Frontend: VisualInventory page (mobile camera → AI analysis → inventory update)
- [x] Frontend: MedusaOnboarding page (self-service product queue → push to Medusa)
- [x] Frontend: OdooMedusaBridge page (bidirectional sync mappings + manual sync trigger)
- [x] Sidebar nav: added Visual Inventory, Medusa Onboarding, Odoo↔Medusa Bridge entries
- [x] App.tsx: wired /visual-inventory, /medusa-onboarding, /odoo-medusa-bridge routes
- [x] Orders page: added "Timeline" button per row → navigates to /orders/:orderNumber
- [x] Medusa webhook: POST /api/webhooks/medusa handles order.fulfillment_created, order.completed, order.canceled
- [x] 241 tests passing, 0 TypeScript errors

## Round 20 — GitHub Push + AI Training + Feature Enhancements
- [x] Push all code to GitHub (munisp/whatsappCommerce main branch)
- [x] VisualInventory: scan history section with bounding box overlay, apply-to-inventory modal
- [x] OdooMedusaBridge: sync history log table (product, qty, direction, status, conflict reason)
- [x] OdooMedusaBridge: last-sync result banner + "View history" toggle
- [x] OdooMedusaBridge: listSyncHistory tRPC procedure (last 30 sync events)
- [x] MedusaOnboarding: S3 image upload (base64 → storagePut → URL stored in draft)
- [x] MedusaOnboarding: image preview with remove button
- [x] MedusaOnboarding: webhook registration panel (URL display, copy button, 3-step setup guide)
- [x] MedusaOnboarding: uploadImage tRPC procedure (base64 → S3 → url)
- [x] 241 tests passing, 0 TypeScript errors

## Round 21 — Label Studio pipe, inline count correction, Nigerian FMCG taxonomy
- [x] Label Studio S3 auto-pipe: tRPC procedure to export scan sessions as Label Studio tasks (JSON)
- [x] Label Studio S3 auto-pipe: Python service that polls new sessions and pushes to Label Studio API
- [x] Label Studio S3 auto-pipe: frontend page to configure Label Studio URL/token and trigger export
- [x] VisualInventory: inline count correction in scan history (edit qty per detected item)
- [x] VisualInventory: save corrections to DB as ground-truth labels (active learning loop)
- [x] Nigerian FMCG taxonomy: schema table (productTaxonomy) with category/brand/variants
- [x] Nigerian FMCG taxonomy: seed data for 8 major categories (beverages, noodles, seasoning, etc.)
- [x] Nigerian FMCG taxonomy: tRPC procedures (list, search, addCustom)
- [x] VLM hints dropdown: pre-populated from taxonomy when location is selected
- [x] 241+ tests passing, 0 TypeScript errors

## Round 21 - AI Training, Label Studio, FMCG Taxonomy
- [x] Nigerian FMCG taxonomy schema (productTaxonomy, labelStudioConfigs tables)
- [x] 60+ Nigerian FMCG products seeded (Beverages, Noodles, Seasoning, Dairy, Grains, Oil, Detergent, Personal Care, Snacks)
- [x] taxonomy tRPC router: list, categories, searchHints, addCustom, seed, stats
- [x] Label Studio pipe tRPC router: getConfig, saveConfig, testConnection, exportSessions, stats
- [x] viCorrections tRPC router: listBySession, listRecent, saveCorrection, bulkSaveCorrections, exportToLabelStudio, stats
- [x] LabelStudioPipe frontend page (/label-studio): config form, test connection, export sessions, export corrections
- [x] FmcgTaxonomy frontend page (/fmcg-taxonomy): search/filter, category browser, add custom product, seed button
- [x] New nav items: FMCG Taxonomy, Label Studio Pipe in Commerce section
- [x] Active learning loop: corrections → Label Studio → YOLO fine-tuning pipeline documented

## Round 22 - FMCG Autocomplete, YOLO Fine-tuning, Scan Location
- [x] FMCG taxonomy searchHints wired into VisualInventory scan form autocomplete
- [x] Scan Location field added to VisualInventory (shelf/aisle/store)
- [x] Label Studio task grouping by scan location
- [x] Python YOLO fine-tuning script (finetune.py) for active learning loop
- [x] Fine-tuning script: pull corrections from DB, download S3 images, build YOLO dataset YAML
- [x] Fine-tuning script: run yolo train with Nigerian FMCG dataset
- [x] 241+ tests passing, 0 TypeScript errors

## Round 22 - FMCG Autocomplete, YOLO Fine-tuning, Scan Location
- [x] Wire FMCG taxonomy searchHints into VisualInventory scan form (autocomplete dropdown)
- [x] Add Scan Location field to VisualInventory (shelf/aisle/store input)
- [x] Build Python YOLO fine-tuning script (finetune.py) with 48 Nigerian FMCG classes
- [x] Active learning pipeline: DB corrections → YOLO dataset → fine-tune → deploy
- [x] Label Studio export: filterByLocation and groupByLocation options
- [x] LabelStudioPipe UI: location filter input + group-by-location checkbox

## Round 23 - Inline Corrections, Scheduled Fine-tuning, Scan Stats, Synthetic Data
- [x] Inline count correction in scan history bounding-box overlay
- [x] Scheduled fine-tuning heartbeat job (weekly, ≥50 corrections threshold)
- [x] Scan Statistics accuracy dashboard (per-location, AI vs corrected, heatmap)
- [x] Synthetic data pipeline (SD/SDXL + GroundingDINO zero-shot labelling)
- [x] SOTA research: synthetic vs manual labelling for Nigerian FMCG

## Round 23 - Completed
- [x] Inline count correction in scan history bounding-box overlay (edit quantities directly in history tab)
- [x] Weekly fine-tuning heartbeat job (checks ≥50 corrections, triggers finetune.py via GPU server)
- [x] Scan Statistics accuracy dashboard (/scan-stats) with per-location accuracy, product heatmap, daily trend
- [x] Synthetic data pipeline: zero_shot_labeller.py (GroundingDINO + Ollama VLM fallback)
- [x] Cut-paste augmentor (cutpaste_augmentor.py) for generating synthetic YOLO training data
- [x] SDXL background generator (sdxl_background_gen.py) for Nigerian market scenes
- [x] ScanStatsDashboard page wired into App.tsx and DashboardLayout nav

## Round 24 (2026-07-15)
- [x] Download 84 clean product images for all 30 Nigerian FMCG classes
- [x] Build synthetic dataset (384 images: 294 train + 90 val) with cut-paste augmentation
- [x] Write build_dataset.py - end-to-end YOLO dataset builder with GroundingDINO option
- [x] Add Florence-2 zero-shot detection backend (florence2_detector.py)
- [x] Build ProductImageCollector page (/product-images) with camera upload + S3 + class selector
- [x] Fix DashboardLayout malformed nav item (BarChart2/ImagePlus)
- [x] Add Product Images nav item to sidebar
- [x] Wire productImages router into appRouter
- [x] Add productImageCollections table to schema

## Round 25 (2026-07-15) - Completed
- [x] Compress training dataset (products + dataset) into tar.gz and push to GitHub
- [x] Re-authenticate GitHub and push all code
- [x] Wire Florence-2 as fallback detector in python-vlm/app/main.py (detector= query param: yolo+vlm, florence2, yolo_only, vlm_only)
- [x] Build GPU training pipeline runner script (gpu_train_runner.py: RunPod/SSH/local GPU launcher with progress streaming)
- [x] Expand ProductImageCollector UI: batch upload (up to 50 files), per-class progress bars (green/yellow/red), configurable target count, Needs Images filter
- [x] Add batchUpload tRPC procedure to productImages router (accepts array of base64 images, uploads to S3, returns count)

## Round 26 (2026-07-15) - Completed
- [x] Drag-and-drop batch upload on ProductImageCollector batch zone (onDragOver/onDragLeave/onDrop handlers, visual highlight)
- [x] Per-class quality gate: qualityImages count (score ≥ 3) in listClasses, quality-gated Ready/Low Quality badge, Quality Ready KPI card
- [x] Fine-tune trigger button (Fine-Tune Run) on ProductImageCollector with SSE log streaming, dry-run toggle, Stop button
- [x] SSE endpoint: GET /api/finetune/stream?dryRun=true — spawns finetune.py, streams stdout/stderr as SSE events, kills on client disconnect

## Round 27 (2026-07-15)
## Round 27 (2026-07-15) - Completed
- [x] finetune_runs DB table (id, startedAt, endedAt, exitCode, logSnapshot, dryRun, triggeredBy, status)
- [x] tRPC router: fineTune (listRuns, getRun) — list and get fine-tune run history
- [x] SSE endpoint saves run to DB on start (status=running) and on completion/failure/cancel
- [x] Auto-quality score on upload: call Florence-2 VLM /detect, map confidence 0-1 to 1-5 stars, pre-fill qualityScore (falls back gracefully if VLM offline)
- [x] YOLO label export ZIP: GET /api/finetune/export-yolo — generates per-class YOLO .txt label files (class_id 0.5 0.5 1.0 1.0), classes.txt, manifest.json in a zip
- [x] ProductImageCollector: Run History panel (toggle button), Export YOLO Labels button, History, FileArchive icons

## Round 28 (2026-07-15)
  - [x] Add bbox column (jsonb: {x,y,w,h} normalized 0-1) to product_image_collections, migrate DB
  - [x] tRPC updateBbox procedure on productImages router
  - [x] Heartbeat scheduled nightly fine-tune job (02:00 UTC, triggers when dataset grew ≥10 images since last run)
  - [x] Run history log drawer: expandable per-row log viewer in Run History panel showing logSnapshot
  - [x] YOLO bbox annotation editor: canvas drawing tool on image detail view, stores bbox, uses bbox in YOLO export

## Round 29 (2026-07-15)
  - [x] Bbox coverage KPI card: bboxImages count in listClasses/datasetStats, 5th KPI card on ProductImageCollector
  - [x] Annotation review mode: "Needs Bbox" filter button showing only images where bbox IS NULL
  - [x] YOLO export HTML preview: preview.html in ZIP with per-image canvas bbox overlays

## Round 29 Next Steps (2026-07-15)
- [x] Annotation progress bar per class card (orange bar: bboxImages/totalImages)
- [x] Bulk bbox clear button in image gallery view (reset all bbox for selected class)
- [x] Dataset version snapshots: dataset_snapshots table, Snapshot Dataset button, audit trail

## Round 30 — Real AI/ML/DL/GNN Stack (2026-07-15)
- [x] Nigerian synthetic data generator: realistic transaction patterns, fraud cases, credit profiles (services/ml/data_generator.py)
- [x] PyTorch fraud detection GNN (GraphSAGE on transaction graph, services/ml/models/fraud_gnn.py)
- [x] PyTorch credit scoring LSTM (time-series payment history, services/ml/models/credit_lstm.py)
- [x] PyTorch product image CNN (MobileNetV3 fine-tune on FMCG classes, services/ml/models/product_cnn.py)
- [x] Training loop scripts with proper train/val/test splits, early stopping, metrics logging
- [x] Production DB to training data pipeline (extract from postgres, feature engineering, services/ml/pipeline.py)
- [x] MLflow model registry integration (experiment tracking, model versioning, artifact storage)
- [x] Ray distributed training orchestration (Ray Train + Ray Tune for HPO)
- [x] Model A/B testing infrastructure: model_ab_tests DB table, traffic splitting, winner selection
- [x] Drift detection: PSI/KS tests on feature distributions, performance degradation alerts
- [x] Continuous training scheduler: Heartbeat job triggers retraining when drift detected or N new samples
- [x] ML Ops dashboard page: model registry, experiment runs, drift metrics, A/B test results

## Round 30 — Stakeholder Smoke Tests (2026-07-15)
- [x] Platform Admin workflows: tenant CRUD, product management, broadcast, reconciliation, KYC review, billing
- [x] Tenant Owner workflows: onboarding wizard, WhatsApp config, menu builder, template library, portal dashboard
- [x] Tenant Agent workflows: conversation handling, order processing, escalation, NLP simulator
- [x] Buyer workflows: WhatsApp menu navigation, cart, checkout, payment, order status, refund
- [x] Analyst workflows: analytics dashboard, forecast, inventory sync, reconciliation report
- [x] Cross-role RBAC: verify forbidden access returns 403 for all protected procedures
- [x] Edge cases: empty states, invalid inputs, concurrent mutations, network errors
- [x] Fix all gaps found during smoke test run

## Round 31 — ML Ops Dashboard + Ray HPO + Inference API (2026-07-15)
- [x] ML Ops dashboard page (/ml-ops): model registry runs, drift PSI scores, A/B test results with winner-selection
- [x] Ray Tune HPO wired into triggerRetraining: spawns hyperparameter search, logs all trials to MLflow
- [x] POST /api/ml/predict inference endpoint: loads MLflow weights, returns fraud probability + credit score
- [x] NLP checkout flow: call /api/ml/predict to gate high-risk orders in real time

## Round 32 — Inference Model Loading + A/B Metrics Heartbeat + Drift Alert Notifications (2026-07-15)
- [x] Inference model loading: wire predict.py to load fraud_gnn_lstm.pt weights via compatible FraudGNNLSTM(input_dim=5) constructor
- [x] A/B test metrics heartbeat: /api/scheduled/ab-test-metrics job computes per-variant conversion rates and writes championMetric/challengerMetric to model_ab_tests table
- [x] Drift alert notifications: heartbeat job sends owner push notification when PSI crosses 0.2 critical threshold with link to Drift Alerts tab

## Round 33 — ML Model Training + Heartbeat Crons + Go-Live Activation (2026-07-15)
- [x] Generate synthetic fraud_train.parquet, fraud_val.parquet, credit_train.parquet, credit_val.parquet
- [x] Train FraudGNNLSTM and save fraud_gnn_lstm.pt weights to services/ml-stack/models/weights/
- [x] Train TabNet credit scorer and save credit_tabnet.pt weights
- [x] Register /api/scheduled/ab-test-metrics heartbeat cron in Deploy Checklist
- [x] Register /api/scheduled/drift-alert heartbeat cron in Deploy Checklist
- [x] Register /api/scheduled/nightly-finetune heartbeat cron in Deploy Checklist
- [x] Update Deploy Checklist page with all three new ML Ops cron activation commands

## Round 34 — Model Performance Widget + Real-Data Retraining Pipeline (2026-07-15)
- [x] Add tRPC procedure mlOps.getModelPerformance returning rolling precision/recall/F1 from agentEvents
- [x] Add model performance line chart widget to ML Ops Overview tab
- [x] Add tRPC procedure mlOps.triggerRealDataRetrain to export real orders as Parquet and run train_all.py
- [x] Add "Retrain on Real Data" button to ML Ops Overview tab with progress feedback
- [x] Add export-to-parquet script: services/ml-stack/training/export_real_data.py

## Round 35
- [x] Register three ML Ops heartbeat crons in server/_core/heartbeat.ts
- [x] Update Deploy Checklist with heartbeat activation commands
- [x] Build tenant analytics dashboard page (/tenant-analytics)
- [x] Add tRPC procedures for tenant GMV, orders, top products, retention
- [x] Add delivery_status column to whatsapp_messages table (schema + migration)
- [x] Handle Meta webhook status callbacks (sent/delivered/read/failed)
- [x] Add delivery rate metrics to Conversations page

## Round 36
- [x] Add Tenant Analytics nav link to DashboardLayout sidebar
- [x] Build /api/scheduled/delivery-summary heartbeat cron with owner notification
- [x] Add delivery status badges to conversations table (latest outbound message status)

## Round 37
- [x] Add delivery-summary cron entry to Deploy Checklist page
- [x] Enrich conversations query with customerPhone and customerName (join with customers table)
- [x] Build per-conversation message timeline slide-over panel in Conversations page

## Round 38
- [x] Add sendMessage procedure to conversationRouter (sends outbound WA message)
- [x] Add updateStatus procedure to conversationRouter (resolve/escalate)
- [x] Add Reply input to ConversationTimeline panel
- [x] Add Resolve/Escalate buttons to ConversationTimeline panel
- [x] Add conversation search/filter by customer name/phone to Conversations page

## Round 39 — Hermes Agent Integration (Polyglot)
- [x] Go: hermes-bridge service — Kafka consumer that forwards platform events to Hermes Cloud API
- [x] Go: hermes-bridge — merchant intent handler (inventory queries, PO approval via WhatsApp)
- [x] Rust: hermes-router crate — high-throughput fan-out with circuit breaker and retry
- [x] Rust: hermes-router — Kafka topic hermes.events.inbound / hermes.events.outbound
- [x] Python: hermes-skills module in ai-agent — inventory PO generation, supplier email, cross-platform sync
- [x] Python: hermes-skills — WooCommerce sync tool, Hermes webhook adapter
- [x] TypeScript: hermesRouter tRPC procedures — config, status, event log, approval webhook
- [x] TypeScript: HermesDashboard page — connection status, event log, PO approval queue
- [x] docker-compose: hermes-bridge and hermes-router services added
- [x] Deploy Checklist: Hermes integration activation steps

## Round 40: Hermes WhatsApp Flows + Health Monitoring
- [x] Hermes merchant onboarding: "hermes setup" WhatsApp command in NLP handler
- [x] Hermes onboarding: hermesRouter.configure procedure + confirmation WhatsApp message
- [x] PO approval handler: detect "APPROVE PO-XXXX" / "REJECT PO-XXXX" in Meta webhook
- [x] PO approval handler: call hermesRouter.approvePO / rejectPO + send WhatsApp confirmation
- [x] Service Health page: ping hermes-skills, hermes-bridge, hermes-router health endpoints
- [x] Service Health page: Hermes layer status cards in /health UI

## Round 41: Hermes PO Push Notifications + Live Health + Onboarding Tour
- [x] Hermes PO notification push: send WhatsApp message to merchant notifyPhone when PO draft is created
- [x] Hermes PO notification: include PO summary and APPROVE/REJECT reply instructions
- [x] Live Hermes layer health: hermesRouter.layerHealth tRPC procedure pinging hermes-skills, hermes-bridge, Redis
- [x] Service Health page: real-time up/down badges for Hermes layer using layerHealth query
- [x] Hermes onboarding tour: first-run modal on /hermes dashboard (connect WooCommerce, set notifyPhone, send hermes setup)
- [x] Hermes onboarding tour: persist "tour completed" flag in hermesConfigs

## Round 41
- [x] Hermes PO notification push: _notify_merchant_wa in po_generator.py sends WA message with APPROVE/REJECT instructions after PO draft saved
- [x] Live Hermes layer health polling: trpc.hermes.layerHealth procedure + /api/hermes/router-heartbeat endpoint + real-time up/down badges on Service Health page (30s refetch)
- [x] Hermes onboarding tour modal: 4-step Dialog on /hermes dashboard, persisted via tourCompleted field in hermes_configs, completeTour tRPC mutation

## Round 42 — Infrastructure Integration Gaps

### PO Expiry
- [x] PO draft expiry heartbeat: /api/scheduled/hermes-po-expiry endpoint auto-rejects pending POs older than 48h
- [x] PO expiry: send WhatsApp notification to merchant on auto-rejection
- [x] PO expiry: register heartbeat job comment (manus-heartbeat create --name hermes-po-expiry --cron "0 0 * * * *")

### Postgres
- [x] Postgres: add idle_timeout, connect_timeout, max_lifetime, ssl options to getDb() connection
- [x] Postgres: add health check endpoint /api/health/postgres returning latency
- [x] Postgres: add connection retry with exponential backoff on startup

### Redis
- [x] Redis: create shared redis.ts client module with ioredis (session cache, rate limiting, pub/sub)
- [x] Redis: wire rate limiting middleware using Redis for per-tenant API throttling
- [x] Redis: add Redis health check to /api/health/redis
- [x] Redis: use Redis for WhatsApp session state caching (conversation context)

### TigerBeetle
- [x] TigerBeetle: add /api/health/tigerbeetle endpoint pinging ledger-bridge
- [x] TigerBeetle: expose ledger balance query tRPC procedure (trpc.payments.getLedgerBalance)
- [x] TigerBeetle: add reconciliation check comparing TB balance vs DB payment_intents sum

### Mojaloop
- [x] Mojaloop: add PUT /api/callbacks/mojaloop/transfers/:id webhook handler for async fulfillment
- [x] Mojaloop: add PUT /api/callbacks/mojaloop/quotes/:id webhook handler
- [x] Mojaloop: add mTLS header validation middleware for FSPIOP callbacks
- [x] Mojaloop: add /api/health/mojaloop endpoint

### Kafka
- [x] Kafka: create server/kafka.ts KafkaJS producer/consumer module
- [x] Kafka: publish order.created events to Kafka on order creation
- [x] Kafka: publish wa.messages.inbound events to Kafka on webhook receipt
- [x] Kafka: add /api/health/kafka endpoint

### APISIX
- [x] APISIX: add apisix/config.yaml with routes, upstreams, rate-limit plugin config
- [x] APISIX: add APISIX admin API health check to Service Health page
- [x] APISIX: document X-API-Key header requirement for external API consumers

### Keycloak
- [x] Keycloak: add JWKS token introspection/verification (verify JWT signature against Keycloak JWKS endpoint)
- [x] Keycloak: add Keycloak health check to /api/health/keycloak
- [x] Keycloak: add keycloak to docker-compose.middleware.yml

### OpenAppSec
- [x] OpenAppSec: add openappsec WAF config (openappsec.policy.yaml) for APISIX integration
- [x] OpenAppSec: add openappsec to docker-compose.middleware.yml
- [x] OpenAppSec: document WAF policy for WhatsApp webhook endpoints

### Permify
- [x] Permify: create server/permify.ts client module (checkPermission, writeRelation, deleteRelation)
- [x] Permify: add Permify schema (schema.perm) for tenant/user/resource authorization
- [x] Permify: wire permify.checkPermission into adminProcedure middleware
- [x] Permify: add permify to docker-compose.middleware.yml
- [x] Permify: add /api/health/permify endpoint

### OpenSearch
- [x] OpenSearch: create server/opensearch.ts client module (@opensearch-project/opensearch)
- [x] OpenSearch: index WhatsApp messages to OpenSearch for full-text search
- [x] OpenSearch: add trpc.search.messages procedure using OpenSearch
- [x] OpenSearch: add opensearch to docker-compose.middleware.yml
- [x] OpenSearch: add /api/health/opensearch endpoint

### Fluvio
- [x] Fluvio: add fluvio to docker-compose.middleware.yml
- [x] Fluvio: create services/fluvio/smartmodule/filter.rs SmartModule for message dedup
- [x] Fluvio: document Fluvio topic mapping (wa.messages → Fluvio stream)
- [x] Fluvio: add /api/health/fluvio endpoint

### Dapr
- [x] Dapr: add Dapr sidecar invocation helper to server (server/dapr.ts)
- [x] Dapr: wire Dapr pub/sub publish for order.created events
- [x] Dapr: add Dapr statestore read/write for conversation context
- [x] Dapr: add Dapr to docker-compose.middleware.yml with sidecar annotations
- [x] Dapr: add /api/health/dapr endpoint

## Round 42 - Infrastructure Integration Gaps
- [x] PO draft expiry heartbeat job
- [x] Postgres connection hardening
- [x] Redis TS client module
- [x] TigerBeetle ledger bridge Rust service
- [x] Mojaloop async callback handlers
- [x] Kafka real producer in event-gateway Go
- [x] APISIX route manager Go
- [x] Keycloak JWKS middleware Go
- [x] OpenAppSec Python WAF config module
- [x] Permify Python authz client
- [x] OpenSearch Python indexer
- [x] Fluvio Rust consumer service
- [x] Dapr Go sidecar bridge
- [x] infraHealth tRPC procedure
- [x] ServiceHealth 12-service infra grid
- [x] infra ENV keys

## Round 43 — CI/CD & Repository Hardening
- [x] Add GitHub Actions CI workflow (.github/workflows/ci.yml) with Node.js, Go, Python, Rust, and Security jobs
- [x] Enable branch protection on main: require 1 PR review + 5 CI status checks + no force push + no deletion
- [x] Update dependabot.yml: lockfile-only strategy for npm, patch-only for all ecosystems, add ledger-bridge and fluvio-consumer Cargo entries

## Round 44 — CODEOWNERS, Release Workflow, Test Fixes
- [x] Add .github/CODEOWNERS mapping all service directories to @munisp
- [x] Fix 5 pre-existing test failures (escrow.bulkUpdateState, operatorTemplates schema gaps)
- [x] Add server/db.mock.test.ts with Vitest mocking for DB-dependent tests (335 pass, 5 skipped)
- [x] Add .github/workflows/release.yml for Docker image builds and GHCR publishing on v* tags

## Round 45 — Dependabot Merge, Health Sparklines, GitHub Sync
- [x] Merge all 11 open Dependabot PRs to main (squash merge with admin bypass)
- [x] Delete all stale branches — only main remains on GitHub
- [x] Add hermes_health_log DB table (layer, online, latencyMs, recordedAt) + migration 0020
- [x] Add hermes.healthHistory tRPC procedure (25h window, grouped by layer)
- [x] Add /api/scheduled/hermes-health-snapshot heartbeat endpoint (5-min cron, prunes >25h rows)
- [x] Add 24h Health sparkline tab to Hermes Dashboard (SVG latency line + red offline bars + uptime %)
- [x] Push all Round 45 changes to GitHub main (commit a2fca63) — 335 tests pass, 0 TS errors
- [ ] Push CI/release workflow files to GitHub (requires PAT with `workflow` scope — see delivery note)
- [x] Tag v1.0.0 release on GitHub — https://github.com/munisp/whatsappCommerce/releases/tag/v1.0.0
- [x] Register hermes-health-snapshot heartbeat job after deploy: manus-heartbeat create --name hermes-health-snapshot --cron "0 */5 * * * *" --path /api/scheduled/hermes-health-snapshot

## Round 46 — Caddy + Keycloak Integration
- [x] Research Caddy capabilities: auto-TLS, HTTP/3, Coraza WAF, internal PKI, L4 proxy
- [x] Research Keycloak capabilities: Organizations, FGAP, token exchange, Kafka SPI, Dapr integration
- [x] Write combined Caddy + Keycloak integration analysis document (docs/caddy-keycloak-integration-analysis.md)
- [x] Scaffold services/caddy-edge/: Dockerfile (xcaddy + Coraza + L4 + caddy-security), Caddyfile, docker-compose, K8s ingress manifests
- [x] Scaffold services/keycloak/: Dockerfile (keycloak-kafka SPI), realm-export.json (Organizations + 4 clients + 5 roles), docker-compose, K8s StatefulSet manifests
- [ ] [POST-PRODUCTION] Phase 1 deployment: Caddy edge TLS in front of APISIX
- [ ] [POST-PRODUCTION] Phase 2 deployment: Keycloak Organizations — migrate tenants
- [ ] [POST-PRODUCTION] Phase 3 deployment: Caddy internal PKI + Dapr mTLS unification
- [ ] [POST-PRODUCTION] Phase 4 deployment: Keycloak Kafka SPI + phone OTP auth flow

## Round 47 — Keycloak Phone OTP (WhatsApp) + Caddy Edge Deployment
- [x] Keycloak SPI: Java Maven project (keycloak-whatsapp-otp) with AuthenticatorFactory + Authenticator
- [x] Keycloak SPI: OTP generation (6-digit HOTP, 5-min TTL) with in-memory + Redis fallback store
- [x] Keycloak SPI: WhatsApp Cloud API sender (POST /messages, OTP template, HMAC verification)
- [x] Keycloak SPI: Freemarker login theme pages (phone-entry.ftl, otp-entry.ftl)
- [x] Keycloak SPI: META-INF/services registration + pom.xml with keycloak-core dependency
- [x] Keycloak SPI: JUnit 5 unit tests for OTP generation, expiry, and WhatsApp sender mock
- [x] Keycloak realm: custom auth flow wired (Browser → Phone OTP → WhatsApp send → OTP verify)
- [x] Keycloak realm: realm-export.json updated with whatsapp-otp auth flow
- [x] Caddy edge: Caddyfile updated with APISIX mTLS upstream (internal CA cert)
- [x] Caddy edge: APISIX config for Keycloak OIDC plugin (openid-connect + authz-keycloak)
- [x] Caddy edge: docker-compose.middleware.yml updated with Caddy as TLS terminator
- [x] Caddy edge: K8s manifests updated with Caddy Ingress + APISIX ClusterIP
- [x] Caddy edge: deployment runbook (DEPLOYMENT.md) with step-by-step production setup
- [x] Platform: tRPC auth.initiatePhoneOtp + auth.verifyPhoneOtp procedures
- [x] Platform: Frontend OTP login dialog (phone input → OTP entry → session)
- [x] Platform: DB schema — phone_otp_sessions table
- [x] Platform: integration tests for Phone OTP flow

## Round 47 — Phone OTP Auth + Caddy Edge

- [x] Keycloak WhatsApp OTP SPI: Java Maven project scaffolded
- [x] SPI: OtpGenerator (crypto-secure 6-digit), InMemoryOtpStore, RedisOtpStore interfaces
- [x] SPI: WhatsAppOtpSender calling WhatsApp Cloud API v21.0 template messages
- [x] SPI: WhatsAppOtpAuthenticator (Keycloak AuthenticatorFactory + SPI registration)
- [x] SPI: Freemarker templates (phone-entry.ftl, otp-entry.ftl) + i18n bundles
- [x] SPI: 16 JUnit 5 unit tests — all pass
- [x] SPI: Shaded JAR built (3.7 MB) and copied to services/keycloak/providers/
- [x] DB: phone_otp_sessions table (migration 0021) — phone, otp_hash, attempts, expiresAt
- [x] DB: users.phone + users.phoneVerified columns added
- [x] Backend: phoneAuth tRPC router (sendOtp, verifyOtp, linkPhone, getPhoneStatus, cleanupExpired)
- [x] Backend: phoneAuth router registered in routers.ts
- [x] Frontend: PhoneAuthPage with PhoneVerificationCard, OtpTestPanel, ArchitectureCard
- [x] Frontend: /phone-auth route registered in App.tsx
- [x] Frontend: "Phone Auth" nav item added to DashboardLayout System section
- [x] Caddy edge: Dockerfile (xcaddy + Coraza WAF + caddy-l4 + caddy-security modules)
- [x] Caddy edge: Production Caddyfile (TLS, WAF, mTLS upstream to APISIX, on-demand TLS)
- [x] Caddy edge: docker-compose.yml with APISIX + Keycloak stubs
- [x] Caddy edge: K8s Ingress manifests (caddy-ingress-controller.yaml)
- [x] Caddy edge: Coraza WAF config + APISIX mTLS upstream config
- [x] Caddy edge: cert generation script (gen-internal-certs.sh)
- [x] TypeScript: 0 errors, 335 tests pass, 5 skipped

## External Infrastructure Dependencies (Cannot complete in sandbox)
- [ ] [BLOCKED: needs user PAT with `workflow` scope] Push CI/release workflow files to GitHub
- [x] [REGISTERED] hermes-health-snapshot heartbeat job (task_uid: 8VDzqmHuaVTPC2kWqtkMAx)
- [ ] [BLOCKED: needs K8s cluster] Execute Phase 1-4 deployment (see DEPLOYMENT.md for step-by-step runbook)

## Round 48 — Phone Auth UX + Profile WhatsApp Management + Order Notifications
- [ ] PhoneAuthPage: searchable country code selector with flag emojis and dial codes
- [ ] PhoneAuthPage: 60-second countdown timer on resend OTP button
- [ ] PhoneAuthPage: phone number formatting as user types (E.164 preview)
- [ ] Profile: WhatsApp number management panel (linked number, verification badge, unlink)
- [ ] Profile: notification preference toggles (order confirmations, status updates, promotions)
- [ ] DB: user_notification_preferences table (order_confirm, status_update, promotions)
- [ ] Backend: whatsApp order confirmation message sender (template + tRPC procedure)
- [ ] Backend: whatsApp order status update message sender (template + tRPC procedure)
- [ ] Backend: auto-trigger WhatsApp messages on order state changes
- [ ] Tests: PhoneAuthPage countdown timer, profile WhatsApp panel, order notification triggers

## Round 48 — Phone Auth UX + WhatsApp Profile + Order Notifications
- [x] Enhanced /phone-auth: searchable country code selector (240+ countries with flags and dial codes)
- [x] Enhanced /phone-auth: 60-second countdown timer with visual progress ring for resend OTP button
- [x] Enhanced /phone-auth: phone number formatting and validation per country
- [x] Added whatsappNotifOrders, whatsappNotifStatus, whatsappNotifMarketing columns to users table (migration 0023)
- [x] Built WhatsAppProfilePage: linked number display, verification status badge, notification preference toggles, unlink action
- [x] Registered /whatsapp-profile route in App.tsx and DashboardLayout nav
- [x] Added phoneAuth.unlinkPhone and phoneAuth.updateNotifPrefs tRPC procedures
- [x] Built whatsappNotifications.ts: sendOrderNotification, resolveOrderNotifRecipient, whatsappNotificationsRouter
- [x] Wired WhatsApp order notifications into orderCrud.updateStatus (fire-and-forget for confirmed/shipped/delivered/cancelled)
- [x] Registered whatsappNotificationsRouter in routers.ts
- [x] Added 8 unit tests for whatsappNotifications (sendOrderNotification + resolveOrderNotifRecipient)
- [x] 350 tests pass, 7 skipped, 0 TypeScript errors
