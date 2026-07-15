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
