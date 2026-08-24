import {
  boolean,
  decimal,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  varchar,
  index,
  unique,
  uniqueIndex,
  numeric,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuid } from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum("user_role", ["user", "admin", "operator", "analyst"]);
export const tenantPlanEnum = pgEnum("tenant_plan", ["starter", "growth", "enterprise"]);
// ─── W12 tenancy ─────────────────────────────────────────────────────────────
// tenantType: retailer = sells via WhatsApp commerce (default),
// supplier = manufacturer/wholesaler on the B2B directory, hybrid = both.
// Stored as varchar (not a PG enum) so values can evolve without ALTER TYPE.
export const tenantTypeEnum = ["retailer", "supplier", "hybrid"] as const;
export type TenantType = (typeof tenantTypeEnum)[number];
// tenant_memberships roles: owner > operator > analyst.
export const membershipRoleEnum = ["owner", "operator", "analyst"] as const;
export type MembershipRole = (typeof membershipRoleEnum)[number];
// ─── end W12 tenancy ─────────────────────────────────────────────────────────
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "trial", "churned"]);
export const productStatusEnum = pgEnum("product_status", ["active", "inactive", "archived"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "resolved", "pending", "snoozed", "bot_active", "human_active"]);
export const orderStatusEnum = pgEnum("order_status", ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"]);
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "initiated", "completed", "failed", "refunded", "refund_initiated", "refund_recorded"]);
export const paymentProviderEnum = pgEnum("payment_provider", ["mojaloop", "stripe", "paystack", "flutterwave", "manual"]);
export const paymentIntentStatusEnum = pgEnum("payment_intent_status", ["initiated", "pending", "completed", "failed", "cancelled", "refunded"]);
export const webhookStatusEnum = pgEnum("webhook_status", ["received", "processing", "processed", "failed"]);
export const serviceStatusEnum = pgEnum("service_status", ["healthy", "degraded", "down", "unknown"]);
export const integrationStatusEnum = pgEnum("integration_status", ["connected", "disconnected", "error"]);
export const menuStatusEnum = pgEnum("menu_status", ["draft", "published", "archived"]);
export const menuPushStatusEnum = pgEnum("menu_push_status", ["idle", "pushing", "success", "failed"]);
export const menuItemTypeEnum = pgEnum("menu_item_type", ["section", "button", "list_item", "quick_reply", "catalog_link", "url"]);
export const templateCategoryEnum = pgEnum("template_category", ["order_confirmation", "shipping_update", "payment_reminder", "welcome", "promotion", "support", "custom"]);
export const templateApprovalStatusEnum = pgEnum("template_approval_status", ["none", "draft", "submitted", "approved", "rejected", "paused"]);

// ─── Users (Auth) ─────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  phone: varchar("phone", { length: 30 }),
  phoneVerified: boolean("phoneVerified").default(false).notNull(),
  role: userRoleEnum("role").default("user").notNull(),
  whatsappNotifOrders: boolean("whatsappNotifOrders").default(true).notNull(),
  whatsappNotifStatus: boolean("whatsappNotifStatus").default(true).notNull(),
  whatsappNotifMarketing: boolean("whatsappNotifMarketing").default(false).notNull(),
  tenantId: varchar("tenantId", { length: 36 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
}, (t) => [
  index("users_phone_idx").on(t.phone),
  index("users_tenant_idx").on(t.tenantId),
]);

// ─── Tenants ──────────────────────────────────────────────────────────────────
export const tenants = pgTable("tenants", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  plan: tenantPlanEnum("plan").default("starter").notNull(),
  status: tenantStatusEnum("status").default("trial").notNull(),
  // W12 tenancy: tenant classification (retailer default; supplier/hybrid set by backfill).
  tenantType: varchar("tenantType", { length: 20 }).default("retailer").notNull().$type<TenantType>(),
  whatsappPhoneNumberId: varchar("whatsappPhoneNumberId", { length: 64 }),
  whatsappBusinessAccountId: varchar("whatsappBusinessAccountId", { length: 64 }),
  webhookVerifyToken: varchar("webhookVerifyToken", { length: 128 }),
  chatwootAccountId: varchar("chatwootAccountId", { length: 64 }),
  chatwootApiToken: varchar("chatwootApiToken", { length: 256 }),
  defaultCurrency: varchar("defaultCurrency", { length: 3 }).default("USD").notNull(),
  defaultLanguage: varchar("defaultLanguage", { length: 10 }).default("en").notNull(),
  aiEnabled: boolean("aiEnabled").default(true).notNull(),
  aiModel: varchar("aiModel", { length: 64 }).default("gpt-4o-mini"),
  settings: jsonb("settings"),
  cogsRate: real("cogsRate").default(0.40).notNull(),
  smsFailoverEnabled: boolean("smsFailoverEnabled").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("tenants_status_idx").on(t.status),
  index("tenants_plan_idx").on(t.plan),
]);
// ─── Tenant SSO Provisioning (legacy — see W12 tenantMemberships below) ───────
// One row per TENANT (not per user) — a single linked SSO identity + role.
// Superseded by tenantMemberships for real multi-user tenant membership;
// kept for backward compat with server/routers/keycloak.ts's portal flow.
// These columns are populated/updated on each successful Keycloak SSO login.
// Stored separately from the main tenants table to keep schema migrations minimal.
export const tenantSsoProfiles = pgTable("tenant_sso_profiles", {
  tenantId: varchar("tenant_id", { length: 36 }).primaryKey(),
  ssoSub: varchar("sso_sub", { length: 256 }),
  ssoEmail: varchar("sso_email", { length: 255 }),
  ssoName: varchar("sso_name", { length: 255 }),
  ssoProvider: varchar("sso_provider", { length: 64 }).default("keycloak"),
  ssoLoginCount: integer("sso_login_count").default(0).notNull(),
  portalRole: varchar("portal_role", { length: 16 }).default("agent").notNull(),
  firstSsoLoginAt: timestamp("first_sso_login_at").defaultNow().notNull(),
  lastSsoLoginAt: timestamp("last_sso_login_at").defaultNow().notNull(),
}, (t) => [
  index("tenant_sso_profiles_email_idx").on(t.ssoEmail),
]);
export type TenantSsoProfile = typeof tenantSsoProfiles.$inferSelect;
export type NewTenantSsoProfile = typeof tenantSsoProfiles.$inferInsert;

// ─── W12 tenancy: multi-user tenant memberships ─────────────────────────────
// Maps users to tenants with an enforced role (owner/operator/analyst).
// users.tenantId remains the "home tenant" shortcut; this table is the
// authoritative many-to-many staff mapping checked by assertTenantAccess.
export const tenantMemberships = pgTable("tenant_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenantId", { length: 36 }).notNull().references(() => tenants.id),
  userId: varchar("userId", { length: 36 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("operator").$type<MembershipRole>(),
  invitedBy: varchar("invitedBy", { length: 36 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("tenant_memberships_tenant_user_uniq").on(t.tenantId, t.userId),
  index("tenant_memberships_user_idx").on(t.userId),
  index("tenant_memberships_tenant_idx").on(t.tenantId),
]);
export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;

// ─── W12 session hardening: revoked JWT IDs ──────────────────────────────────
// Rows are checked on every authenticated request (cached 60s). Two row kinds:
//   - jti = token jti            → that specific token is revoked (logout)
//   - jti = 'user:' + userId     → revoke-all marker for that user (admin)
// expiresAt mirrors the token's exp so stale rows can be garbage-collected.
export const sessionRevocations = pgTable("session_revocations", {
  jti: varchar("jti", { length: 64 }).primaryKey(),
  userId: varchar("userId", { length: 36 }),
  expiresAt: timestamp("expiresAt").notNull(),
});
export type SessionRevocation = typeof sessionRevocations.$inferSelect;
export type NewSessionRevocation = typeof sessionRevocations.$inferInsert;
// ─── end W12 tenancy ─────────────────────────────────────────────────────────

// ─── Products ─────────────────────────────────────────────────────────────────
export const products = pgTable("products", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  sku: varchar("sku", { length: 100 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }),
  price: decimal("price", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("USD").notNull(),
  imageUrl: text("imageUrl"),
  status: productStatusEnum("status").default("active").notNull(),
  stockQuantity: integer("stockQuantity").default(0).notNull(),
  lowStockThreshold: integer("lowStockThreshold").default(10),
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("products_tenant_idx").on(t.tenantId),
  index("products_status_idx").on(t.status),
  uniqueIndex("products_tenant_sku_idx").on(t.tenantId, t.sku),
]);

// ─── Customers ────────────────────────────────────────────────────────────────
export const customers = pgTable("customers", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  whatsappPhone: varchar("whatsappPhone", { length: 30 }).notNull(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  language: varchar("language", { length: 10 }).default("en"),
  crmContactId: varchar("crmContactId", { length: 64 }),
  totalOrders: integer("totalOrders").default(0).notNull(),
  totalSpent: decimal("totalSpent", { precision: 14, scale: 2 }).default("0.00").notNull(),
  lastOrderAt: timestamp("lastOrderAt"),
  tags: jsonb("tags"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("customers_tenant_idx").on(t.tenantId),
  uniqueIndex("customers_tenant_phone_idx").on(t.tenantId, t.whatsappPhone),
]);

// ─── Conversations ────────────────────────────────────────────────────────────
export const conversations = pgTable("conversations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerId: varchar("customerId", { length: 36 }).notNull(),
  chatwootConversationId: varchar("chatwootConversationId", { length: 64 }),
  status: conversationStatusEnum("status").default("open").notNull(),
  channel: varchar("channel", { length: 30 }).default("whatsapp").notNull(),
  assignedAgentId: varchar("assignedAgentId", { length: 64 }),
  currentFlowStep: varchar("currentFlowStep", { length: 100 }).default("greeting"),
  lastIntent: varchar("lastIntent", { length: 100 }),
  cartId: varchar("cartId", { length: 36 }),
  messageCount: integer("messageCount").default(0).notNull(),
  aiHandled: boolean("aiHandled").default(true).notNull(),
  escalatedAt: timestamp("escalatedAt"),
  resolvedAt: timestamp("resolvedAt"),
  firstResponseAt: timestamp("firstResponseAt"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("conversations_tenant_idx").on(t.tenantId),
  index("conversations_status_idx").on(t.status),
  index("conversations_customer_idx").on(t.customerId),
]);

// ─── Orders ───────────────────────────────────────────────────────────────────
export const orders = pgTable("orders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerId: varchar("customerId", { length: 36 }).notNull(),
  conversationId: varchar("conversationId", { length: 36 }),
  orderNumber: varchar("orderNumber", { length: 50 }).notNull(),
  status: orderStatusEnum("status").default("pending").notNull(),
  totalAmount: decimal("totalAmount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("USD").notNull(),
  paymentStatus: paymentStatusEnum("paymentStatus").default("unpaid").notNull(),
  paymentIntentId: varchar("paymentIntentId", { length: 64 }),
  shippingAddress: jsonb("shippingAddress"),
  items: jsonb("items"),
  // Structured extras: fulfillment ("pickup"|"delivery"), subtotal,
  // deliveryFee, receiptReview flag, receipt scan details.
  metadata: jsonb("metadata"),
  notes: text("notes"),
  erpOrderId: varchar("erpOrderId", { length: 64 }),
  // COD/offline-trade (W17/F10): current cash-on-delivery flow state. NULL for
  // non-COD orders. See server/services/codFlow.ts for the state machine.
  codState: varchar("codState", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("orders_tenant_idx").on(t.tenantId),
  index("orders_status_idx").on(t.status),
  index("orders_customer_idx").on(t.customerId),
  index("orders_cod_state_idx").on(t.tenantId, t.codState),
  uniqueIndex("orders_number_idx").on(t.tenantId, t.orderNumber),
]);

// ─── COD flow events (W17/F10) ───────────────────────────────────────────────
// Append-only audit trail for the cash-on-delivery state machine. Settlement
// idempotency is enforced by partial unique indexes (see 0056 SQL): at most
// one 'cash_collected' and one 'settled' event per order.
export const codEvents = pgTable("cod_events", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  orderId: varchar("orderId", { length: 36 }).notNull(),
  fromState: varchar("fromState", { length: 32 }),
  toState: varchar("toState", { length: 32 }).notNull(),
  actor: varchar("actor", { length: 128 }).notNull(),
  note: text("note"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("cod_events_tenant_idx").on(t.tenantId),
  index("cod_events_order_idx").on(t.orderId),
]);

export type CodEvent = typeof codEvents.$inferSelect;
export type NewCodEvent = typeof codEvents.$inferInsert;

// ─── Payment Intents ──────────────────────────────────────────────────────────
export const paymentIntents = pgTable("payment_intents", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  orderId: varchar("orderId", { length: 36 }).notNull(),
  customerId: varchar("customerId", { length: 36 }).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("USD").notNull(),
  provider: paymentProviderEnum("provider").default("stripe").notNull(),
  status: paymentIntentStatusEnum("status").default("initiated").notNull(),
  providerPaymentId: varchar("providerPaymentId", { length: 256 }),
  idempotencyKey: varchar("idempotencyKey", { length: 128 }).notNull().unique(),
  ledgerPendingId: varchar("ledgerPendingId", { length: 36 }),
  failureReason: text("failureReason"),
  metadata: jsonb("metadata"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("payment_intents_tenant_idx").on(t.tenantId),
  index("payment_intents_status_idx").on(t.status),
  index("payment_intents_order_idx").on(t.orderId),
]);

// ─── AI Agent Events ──────────────────────────────────────────────────────────
export const agentEvents = pgTable("agent_events", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  conversationId: varchar("conversationId", { length: 36 }).notNull(),
  eventType: varchar("eventType", { length: 100 }).notNull(),
  intentType: varchar("intentType", { length: 100 }),
  confidence: decimal("confidence", { precision: 4, scale: 3 }),
  latencyMs: integer("latencyMs"),
  escalated: boolean("escalated").default(false).notNull(),
  toolCalls: jsonb("toolCalls"),
  inputTokens: integer("inputTokens"),
  outputTokens: integer("outputTokens"),
  model: varchar("model", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("agent_events_tenant_idx").on(t.tenantId),
  index("agent_events_conversation_idx").on(t.conversationId),
  index("agent_events_created_idx").on(t.createdAt),
]);

// ─── Webhook Events ───────────────────────────────────────────────────────────
export const webhookEvents = pgTable("webhook_events", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  source: varchar("source", { length: 50 }).notNull(),
  eventType: varchar("eventType", { length: 100 }).notNull(),
  status: webhookStatusEnum("status").default("received").notNull(),
  payload: jsonb("payload"),
  processingError: text("processingError"),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("webhook_events_tenant_idx").on(t.tenantId),
  index("webhook_events_status_idx").on(t.status),
]);

// ─── Service Health ───────────────────────────────────────────────────────────
export const serviceHealth = pgTable("service_health", {
  id: serial("id").primaryKey(),
  serviceName: varchar("serviceName", { length: 100 }).notNull(),
  status: serviceStatusEnum("status").default("unknown").notNull(),
  latencyMs: integer("latencyMs"),
  errorRate: decimal("errorRate", { precision: 5, scale: 2 }),
  lastCheckedAt: timestamp("lastCheckedAt").defaultNow().notNull(),
  details: jsonb("details"),
}, (t) => [
  uniqueIndex("service_health_name_idx").on(t.serviceName),
]);

// ─── Twenty CRM Integration ───────────────────────────────────────────────────
export const twentyIntegrations = pgTable("twenty_integrations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull().unique(),
  baseUrl: varchar("baseUrl", { length: 512 }).notNull(),
  apiKey: varchar("apiKey", { length: 512 }).notNull(),
  workspaceId: varchar("workspaceId", { length: 64 }),
  status: integrationStatusEnum("status").default("disconnected").notNull(),
  lastSyncAt: timestamp("lastSyncAt"),
  syncContacts: boolean("syncContacts").default(true).notNull(),
  syncDeals: boolean("syncDeals").default(true).notNull(),
  whatsappEnabled: boolean("whatsappEnabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("twenty_integrations_tenant_idx").on(t.tenantId),
]);

export const twentyContacts = pgTable("twenty_contacts", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  twentyId: varchar("twentyId", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 30 }),
  company: varchar("company", { length: 255 }),
  jobTitle: varchar("jobTitle", { length: 255 }),
  stage: varchar("stage", { length: 100 }),
  whatsappPhone: varchar("whatsappPhone", { length: 30 }),
  lastWhatsappAt: timestamp("lastWhatsappAt"),
  customerId: varchar("customerId", { length: 36 }),
  rawData: jsonb("rawData"),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("twenty_contacts_tenant_idx").on(t.tenantId),
  uniqueIndex("twenty_contacts_twenty_id_idx").on(t.tenantId, t.twentyId),
]);

export const twentyDeals = pgTable("twenty_deals", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  twentyId: varchar("twentyId", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }),
  stage: varchar("stage", { length: 100 }),
  amount: decimal("amount", { precision: 14, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  contactId: varchar("contactId", { length: 36 }),
  closeDate: timestamp("closeDate"),
  probability: integer("probability"),
  rawData: jsonb("rawData"),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("twenty_deals_tenant_idx").on(t.tenantId),
  uniqueIndex("twenty_deals_twenty_id_idx").on(t.tenantId, t.twentyId),
]);

// ─── Odoo ERP Integration ─────────────────────────────────────────────────────
export const odooIntegrations = pgTable("odoo_integrations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull().unique(),
  baseUrl: varchar("baseUrl", { length: 512 }).notNull(),
  database: varchar("database", { length: 128 }).notNull(),
  username: varchar("username", { length: 255 }).notNull(),
  apiKey: varchar("apiKey", { length: 512 }).notNull(),
  status: integrationStatusEnum("status").default("disconnected").notNull(),
  lastSyncAt: timestamp("lastSyncAt"),
  syncProducts: boolean("syncProducts").default(true).notNull(),
  syncOrders: boolean("syncOrders").default(true).notNull(),
  syncInvoices: boolean("syncInvoices").default(true).notNull(),
  whatsappEnabled: boolean("whatsappEnabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("odoo_integrations_tenant_idx").on(t.tenantId),
]);

export const odooSyncedProducts = pgTable("odoo_synced_products", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  odooId: integer("odooId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  internalRef: varchar("internalRef", { length: 100 }),
  price: decimal("price", { precision: 12, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  category: varchar("category", { length: 255 }),
  stockQty: decimal("stockQty", { precision: 12, scale: 2 }),
  active: boolean("active").default(true).notNull(),
  localProductId: varchar("localProductId", { length: 36 }),
  rawData: jsonb("rawData"),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("odoo_products_tenant_idx").on(t.tenantId),
  uniqueIndex("odoo_products_odoo_id_idx").on(t.tenantId, t.odooId),
]);

export const odooSyncedOrders = pgTable("odoo_synced_orders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  odooId: integer("odooId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  partnerName: varchar("partnerName", { length: 255 }),
  partnerPhone: varchar("partnerPhone", { length: 30 }),
  state: varchar("state", { length: 50 }),
  amountTotal: decimal("amountTotal", { precision: 14, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  dateOrder: timestamp("dateOrder"),
  whatsappSent: boolean("whatsappSent").default(false).notNull(),
  localOrderId: varchar("localOrderId", { length: 36 }),
  rawData: jsonb("rawData"),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("odoo_orders_tenant_idx").on(t.tenantId),
  uniqueIndex("odoo_orders_odoo_id_idx").on(t.tenantId, t.odooId),
]);

export const odooSyncedInvoices = pgTable("odoo_synced_invoices", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  odooId: integer("odooId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  partnerName: varchar("partnerName", { length: 255 }),
  partnerPhone: varchar("partnerPhone", { length: 30 }),
  state: varchar("state", { length: 50 }),
  amountTotal: decimal("amountTotal", { precision: 14, scale: 2 }),
  amountResidual: decimal("amountResidual", { precision: 14, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  invoiceDate: timestamp("invoiceDate"),
  dueDate: timestamp("dueDate"),
  whatsappSent: boolean("whatsappSent").default(false).notNull(),
  rawData: jsonb("rawData"),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("odoo_invoices_tenant_idx").on(t.tenantId),
  uniqueIndex("odoo_invoices_odoo_id_idx").on(t.tenantId, t.odooId),
]);

// ─── WhatsApp Menu Builder ────────────────────────────────────────────────────
export const whatsappMenus = pgTable("whatsapp_menus", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: menuStatusEnum("status").default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  publishedAt: timestamp("publishedAt"),
  lastPushedAt: timestamp("lastPushedAt"),
  pushStatus: menuPushStatusEnum("pushStatus").default("idle").notNull(),
  pushError: text("pushError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("whatsapp_menus_tenant_idx").on(t.tenantId),
  index("whatsapp_menus_status_idx").on(t.status),
]);

export const whatsappMenuItems = pgTable("whatsapp_menu_items", {
  id: varchar("id", { length: 36 }).primaryKey(),
  menuId: varchar("menuId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  parentId: varchar("parentId", { length: 36 }),
  type: menuItemTypeEnum("type").default("button").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  payload: varchar("payload", { length: 255 }),
  url: text("url"),
  sortOrder: integer("sortOrder").default(0).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("menu_items_menu_idx").on(t.menuId),
  index("menu_items_tenant_idx").on(t.tenantId),
  index("menu_items_parent_idx").on(t.parentId),
]);

// ─── Tenant Menu Assignments ──────────────────────────────────────────────────
export const tenantMenuAssignments = pgTable("tenant_menu_assignments", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  menuId: varchar("menuId", { length: 36 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  assignedBy: varchar("assignedBy", { length: 64 }),
}, (t) => [
  index("tenant_menu_assign_tenant_idx").on(t.tenantId),
  uniqueIndex("tenant_menu_assign_unique_idx").on(t.tenantId, t.menuId),
]);

// ─── WhatsApp Template Library ────────────────────────────────────────────────
export const whatsappTemplates = pgTable("whatsapp_templates", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  category: templateCategoryEnum("category").default("custom").notNull(),
  language: varchar("language", { length: 10 }).default("en").notNull(),
  headerText: varchar("headerText", { length: 255 }),
  bodyText: text("bodyText").notNull(),
  footerText: varchar("footerText", { length: 255 }),
  variables: jsonb("variables"),
  buttons: jsonb("buttons"),
  isActive: boolean("isActive").default(true).notNull(),
  usageCount: integer("usageCount").default(0).notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
  approvalStatus: templateApprovalStatusEnum("approvalStatus").default("none").notNull(),
  approvalSubmittedAt: timestamp("approvalSubmittedAt"),
  approvalUpdatedAt: timestamp("approvalUpdatedAt"),
  rejectionReason: text("rejectionReason"),
  metaTemplateId: varchar("metaTemplateId", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("templates_tenant_idx").on(t.tenantId),
  index("templates_category_idx").on(t.category),
  uniqueIndex("templates_tenant_name_idx").on(t.tenantId, t.name),
]);

// ─── Types ────────────────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type InsertTenant = typeof tenants.$inferInsert;
export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type InsertPaymentIntent = typeof paymentIntents.$inferInsert;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type InsertAgentEvent = typeof agentEvents.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type InsertWebhookEvent = typeof webhookEvents.$inferInsert;
export type TwentyIntegration = typeof twentyIntegrations.$inferSelect;
export type TwentyContact = typeof twentyContacts.$inferSelect;
export type TwentyDeal = typeof twentyDeals.$inferSelect;
export type OdooIntegration = typeof odooIntegrations.$inferSelect;
export type OdooSyncedProduct = typeof odooSyncedProducts.$inferSelect;
export type OdooSyncedOrder = typeof odooSyncedOrders.$inferSelect;
export type OdooSyncedInvoice = typeof odooSyncedInvoices.$inferSelect;
export type WhatsappMenu = typeof whatsappMenus.$inferSelect;
export type WhatsappMenuItem = typeof whatsappMenuItems.$inferSelect;
export type TenantMenuAssignment = typeof tenantMenuAssignments.$inferSelect;
export type WhatsappTemplate = typeof whatsappTemplates.$inferSelect;
export type InsertWhatsappTemplate = typeof whatsappTemplates.$inferInsert;

// ─── Template Versions ────────────────────────────────────────────────────────
export const templateVersionStatusEnum = pgEnum("template_version_status", ["draft", "published", "archived"]);

export const templateVersions = pgTable("template_versions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  templateId: varchar("templateId", { length: 36 }).notNull(),
  version: integer("version").default(1).notNull(),
  bodyText: text("bodyText").notNull(),
  headerText: varchar("headerText", { length: 255 }),
  footerText: varchar("footerText", { length: 255 }),
  variables: jsonb("variables"),
  buttons: jsonb("buttons"),
  status: templateVersionStatusEnum("status").default("draft").notNull(),
  changeSummary: varchar("changeSummary", { length: 500 }),
  changedBy: varchar("changedBy", { length: 64 }),
  publishedAt: timestamp("publishedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("template_versions_template_idx").on(t.templateId),
  index("template_versions_status_idx").on(t.status),
  uniqueIndex("template_versions_unique_idx").on(t.templateId, t.version),
]);

// ─── Broadcast Campaigns ──────────────────────────────────────────────────────
// ─── Inventory Sync ───────────────────────────────────────────────────────────
export const inventorySyncStatusEnum = pgEnum("inventory_sync_status", ["idle", "syncing", "success", "failed"]);

export const inventorySnapshots = pgTable("inventory_snapshots", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  productId: varchar("productId", { length: 36 }).notNull(),
  odooProductId: integer("odooProductId"),
  stockQty: decimal("stockQty", { precision: 12, scale: 2 }).default("0").notNull(),
  reservedQty: decimal("reservedQty", { precision: 12, scale: 2 }).default("0").notNull(),
  availableQty: decimal("availableQty", { precision: 12, scale: 2 }).default("0").notNull(),
  lastSyncedAt: timestamp("lastSyncedAt").defaultNow().notNull(),
  syncSource: varchar("syncSource", { length: 30 }).default("odoo").notNull(),
}, (t) => [
  index("inv_snap_tenant_idx").on(t.tenantId),
  uniqueIndex("inv_snap_product_idx").on(t.tenantId, t.productId),
]);

// ─── Inventory Reservations (pre-payment stock holds) ────────────────────────
// One row per (order, product) stock hold. The product's stockQuantity is
// decremented atomically at reserve time (UPDATE ... WHERE stockQuantity >=
// qty), flipped reserved→committed on payment confirmation, and released
// (stock credited back) on cancel / payment failure / TTL expiry.
// status: 'reserved' | 'committed' | 'released' (CHECK constraint in 0031).
export const inventoryReservations = pgTable("inventory_reservations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  orderId: varchar("orderId", { length: 36 }).notNull(),
  productId: varchar("productId", { length: 36 }).notNull(),
  qty: integer("qty").notNull(),
  status: varchar("status", { length: 16 }).default("reserved").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("inventory_reservations_tenant_idx").on(t.tenantId),
  index("inventory_reservations_order_idx").on(t.orderId),
  index("inventory_reservations_status_expires_idx").on(t.status, t.expiresAt),
]);
export type InventoryReservation = typeof inventoryReservations.$inferSelect;
export type InsertInventoryReservation = typeof inventoryReservations.$inferInsert;

// ─── Back-in-stock waitlist (migration 0036) ────────────────────────────────
// Buyers hit an out-of-stock product and opt in ("NOTIFY ME"); when stock
// goes 0→>0 every unnotified entry gets one WhatsApp alert (notifiedAt set).
export const waitlistEntries = pgTable("waitlist_entries", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  productId: varchar("productId", { length: 36 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  notifiedAt: timestamp("notifiedAt"),
}, (t) => [
  index("waitlist_entries_tenant_idx").on(t.tenantId),
  index("waitlist_entries_product_idx").on(t.productId),
  uniqueIndex("waitlist_entries_tenant_product_phone_idx").on(t.tenantId, t.productId, t.phone),
]);
export type WaitlistEntry = typeof waitlistEntries.$inferSelect;
export type InsertWaitlistEntry = typeof waitlistEntries.$inferInsert;

export const inventorySyncLog = pgTable("inventory_sync_log", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  source: varchar("source", { length: 30 }).default("odoo").notNull(),
  status: inventorySyncStatusEnum("status").default("idle").notNull(),
  recordsSynced: integer("recordsSynced").default(0).notNull(),
  errors: text("errors"),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
}, (t) => [
  index("inv_sync_log_tenant_idx").on(t.tenantId),
  index("inv_sync_log_synced_idx").on(t.syncedAt),
]);

// ─── Broadcast A/B Tests ──────────────────────────────────────────────────────
export const abWinnerCriteriaEnum = pgEnum("ab_winner_criteria", ["read_rate", "delivery_rate", "click_rate"]);

export const broadcastAbTests = pgTable("broadcast_ab_tests", {
  id: varchar("id", { length: 36 }).primaryKey(),
  campaignId: varchar("campaignId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  variantATemplateId: varchar("variantATemplateId", { length: 36 }).notNull(),
  variantBTemplateId: varchar("variantBTemplateId", { length: 36 }).notNull(),
  variantAName: varchar("variantAName", { length: 100 }).default("Variant A").notNull(),
  variantBName: varchar("variantBName", { length: 100 }).default("Variant B").notNull(),
  splitRatio: integer("splitRatio").default(50).notNull(),
  winnerCriteria: abWinnerCriteriaEnum("winnerCriteria").default("read_rate").notNull(),
  winnerVariant: varchar("winnerVariant", { length: 1 }),
  testEndAt: timestamp("testEndAt"),
  variantASent: integer("variantASent").default(0).notNull(),
  variantADelivered: integer("variantADelivered").default(0).notNull(),
  variantARead: integer("variantARead").default(0).notNull(),
  variantBSent: integer("variantBSent").default(0).notNull(),
  variantBDelivered: integer("variantBDelivered").default(0).notNull(),
  variantBRead: integer("variantBRead").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("ab_tests_campaign_idx").on(t.campaignId),
  index("ab_tests_tenant_idx").on(t.tenantId),
]);

// ─── Broadcast Campaigns ──────────────────────────────────────────────────────
export const broadcastStatusEnum = pgEnum("broadcast_status", ["draft", "scheduled", "sending", "completed", "cancelled", "failed"]);
export const recipientStatusEnum = pgEnum("recipient_status", ["pending", "sent", "delivered", "read", "failed", "opted_out"]);

export const broadcastCampaigns = pgTable("broadcast_campaigns", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  templateId: varchar("templateId", { length: 36 }),
  templateVersionId: varchar("templateVersionId", { length: 36 }),
  isAbTest: boolean("isAbTest").default(false).notNull(),
  abTestId: varchar("abTestId", { length: 36 }),
  segment: varchar("segment", { length: 100 }).default("all"),
  segmentFilter: jsonb("segmentFilter"),
  status: broadcastStatusEnum("status").default("draft").notNull(),
  varMapping: jsonb("varMapping"),
  scheduledAt: timestamp("scheduledAt"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  totalRecipients: integer("totalRecipients").default(0).notNull(),
  sentCount: integer("sentCount").default(0).notNull(),
  deliveredCount: integer("deliveredCount").default(0).notNull(),
  readCount: integer("readCount").default(0).notNull(),
  failedCount: integer("failedCount").default(0).notNull(),
  createdBy: varchar("createdBy", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("broadcast_tenant_idx").on(t.tenantId),
  index("broadcast_status_idx").on(t.status),
]);

export const broadcastRecipients = pgTable("broadcast_recipients", {
  id: varchar("id", { length: 36 }).primaryKey(),
  campaignId: varchar("campaignId", { length: 36 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  name: varchar("name", { length: 255 }),
  variables: jsonb("variables"),
  status: recipientStatusEnum("status").default("pending").notNull(),
  sentAt: timestamp("sentAt"),
  deliveredAt: timestamp("deliveredAt"),
  readAt: timestamp("readAt"),
  failedAt: timestamp("failedAt"),
  failureReason: varchar("failureReason", { length: 500 }),
  messageId: varchar("messageId", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("broadcast_recipients_campaign_idx").on(t.campaignId),
  index("broadcast_recipients_status_idx").on(t.status),
]);

// ─── Billing Model & Tenant Onboarding ───────────────────────────────────────
export const billingModelEnum = pgEnum("billing_model", ["profit_sharing", "subscription", "hybrid"]);
export const subscriptionCycleEnum = pgEnum("subscription_cycle", ["monthly", "annual"]);
export const onboardingStepEnum = pgEnum("onboarding_step", ["business_profile", "billing_model", "whatsapp_setup", "ai_config", "review", "completed"]);

export const tenantOnboarding = pgTable("tenant_onboarding", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull().unique(),
  currentStep: onboardingStepEnum("currentStep").default("business_profile").notNull(),
  billingModel: billingModelEnum("billingModel"),
  profitShareRate: varchar("profitShareRate", { length: 10 }),
  subscriptionFee: varchar("subscriptionFee", { length: 20 }),
  subscriptionCycle: subscriptionCycleEnum("subscriptionCycle").default("monthly"),
  minMonthlyFee: varchar("minMonthlyFee", { length: 20 }),
  maxProfitShareRate: varchar("maxProfitShareRate", { length: 10 }),
  businessType: varchar("businessType", { length: 100 }),
  businessDescription: varchar("businessDescription", { length: 1000 }),
  businessCountry: varchar("businessCountry", { length: 100 }),
  businessCurrency: varchar("businessCurrency", { length: 3 }).default("USD"),
  estimatedMonthlyGmv: varchar("estimatedMonthlyGmv", { length: 20 }),
  estimatedMonthlyOrders: integer("estimatedMonthlyOrders"),
  whatsappVerified: boolean("whatsappVerified").default(false).notNull(),
  aiConfigured: boolean("aiConfigured").default(false).notNull(),
  onboardingNotes: varchar("onboardingNotes", { length: 2000 }),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("onboarding_tenant_idx").on(t.tenantId),
]);

// ─── Template Approval History ────────────────────────────────────────────────
export const templateApprovalHistory = pgTable("template_approval_history", {
  id: varchar("id", { length: 36 }).primaryKey(),
  templateId: varchar("templateId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  fromStatus: varchar("fromStatus", { length: 50 }),
  toStatus: varchar("toStatus", { length: 50 }).notNull(),
  changedBy: varchar("changedBy", { length: 255 }),
  reason: varchar("reason", { length: 1000 }),
  metaSubmissionId: varchar("metaSubmissionId", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("approval_history_template_idx").on(t.templateId),
]);

// ─── Extended Types ───────────────────────────────────────────────────────────
export type TemplateVersion = typeof templateVersions.$inferSelect;
export type InsertTemplateVersion = typeof templateVersions.$inferInsert;
export type BroadcastCampaign = typeof broadcastCampaigns.$inferSelect;
export type InsertBroadcastCampaign = typeof broadcastCampaigns.$inferInsert;
export type BroadcastRecipient = typeof broadcastRecipients.$inferSelect;
export type InsertBroadcastRecipient = typeof broadcastRecipients.$inferInsert;

// ─── Broadcast Journeys (W17 F8) ─────────────────────────────────────────────
// A journey is an ordered list of steps (send_template / wait / wait_for_reply
// / condition / exit) over the existing broadcast/template infrastructure.
// Definitions live here; per-customer progress lives in broadcast_journey_runs
// and is advanced by runDueJourneySteps() (server/services/journeyBuilder.ts).
export const journeyStatusEnum = pgEnum("journey_status", ["draft", "active", "paused", "archived"]);
export const journeyRunStateEnum = pgEnum("journey_run_state", ["waiting", "done", "exited", "failed"]);

export const broadcastJourneys = pgTable("broadcast_journeys", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  status: journeyStatusEnum("status").default("draft").notNull(),
  steps: jsonb("steps").notNull(),
  entryAudience: jsonb("entryAudience"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("broadcast_journeys_tenant_idx").on(t.tenantId),
  index("broadcast_journeys_status_idx").on(t.status),
]);

export const broadcastJourneyRuns = pgTable("broadcast_journey_runs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  journeyId: varchar("journeyId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerId: varchar("customerId", { length: 36 }).notNull(),
  currentStep: integer("currentStep").default(0).notNull(),
  state: journeyRunStateEnum("state").default("waiting").notNull(),
  context: jsonb("context"),
  nextRunAt: timestamp("nextRunAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("broadcast_journey_runs_journey_idx").on(t.journeyId),
  index("broadcast_journey_runs_tenant_idx").on(t.tenantId),
  index("broadcast_journey_runs_due_idx").on(t.state, t.nextRunAt),
]);

export type BroadcastJourney = typeof broadcastJourneys.$inferSelect;
export type InsertBroadcastJourney = typeof broadcastJourneys.$inferInsert;
export type BroadcastJourneyRun = typeof broadcastJourneyRuns.$inferSelect;
export type InsertBroadcastJourneyRun = typeof broadcastJourneyRuns.$inferInsert;
export type InventorySnapshot = typeof inventorySnapshots.$inferSelect;
export type InsertInventorySnapshot = typeof inventorySnapshots.$inferInsert;
export type InventorySyncLog = typeof inventorySyncLog.$inferSelect;
export type BroadcastAbTest = typeof broadcastAbTests.$inferSelect;
export type InsertBroadcastAbTest = typeof broadcastAbTests.$inferInsert;
export type TenantOnboarding = typeof tenantOnboarding.$inferSelect;
export type InsertTenantOnboarding = typeof tenantOnboarding.$inferInsert;
export type TemplateApprovalHistory = typeof templateApprovalHistory.$inferSelect;

// ─── KYC/KYB ─────────────────────────────────────────────────────────────────
export const kycDocumentTypeEnum = pgEnum("kyc_document_type", [
  "national_id", "passport", "drivers_license", "residence_permit",
  "utility_bill", "bank_statement", "business_registration",
  "certificate_of_incorporation", "tax_certificate", "directors_id",
]);
export const kycStatusEnum = pgEnum("kyc_status", [
  "not_started", "pending", "under_review", "approved", "rejected", "expired", "resubmit_required",
]);
export const kycTypeEnum = pgEnum("kyc_type", ["kyc", "kyb"]);
export const livenessStatusEnum = pgEnum("liveness_status", [
  "not_started", "in_progress", "passed", "failed", "expired",
]);

export const kycApplications = pgTable("kyc_applications", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  type: kycTypeEnum("type").default("kyb").notNull(),
  status: kycStatusEnum("status").default("not_started").notNull(),
  applicantName: varchar("applicantName", { length: 255 }),
  applicantEmail: varchar("applicantEmail", { length: 320 }),
  applicantPhone: varchar("applicantPhone", { length: 30 }),
  businessName: varchar("businessName", { length: 255 }),
  businessRegistrationNumber: varchar("businessRegistrationNumber", { length: 100 }),
  businessCountry: varchar("businessCountry", { length: 100 }),
  businessType: varchar("businessType", { length: 100 }),
  riskScore: varchar("riskScore", { length: 10 }),
  reviewedBy: varchar("reviewedBy", { length: 255 }),
  reviewNotes: text("reviewNotes"),
  rejectionReason: text("rejectionReason"),
  submittedAt: timestamp("submittedAt"),
  reviewedAt: timestamp("reviewedAt"),
  approvedAt: timestamp("approvedAt"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("kyc_app_tenant_idx").on(t.tenantId),
  index("kyc_app_status_idx").on(t.status),
]);

export const kycDocuments = pgTable("kyc_documents", {
  id: varchar("id", { length: 36 }).primaryKey(),
  applicationId: varchar("applicationId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  documentType: kycDocumentTypeEnum("documentType").notNull(),
  fileKey: varchar("fileKey", { length: 512 }),
  fileUrl: text("fileUrl"),
  fileName: varchar("fileName", { length: 255 }),
  mimeType: varchar("mimeType", { length: 100 }),
  fileSizeBytes: integer("fileSizeBytes"),
  ocrRawText: text("ocrRawText"),
  ocrConfidence: varchar("ocrConfidence", { length: 10 }),
  extractedData: jsonb("extractedData"),
  vlmAnalysis: jsonb("vlmAnalysis"),
  doclingStructure: jsonb("doclingStructure"),
  isAuthentic: boolean("isAuthentic"),
  isTampered: boolean("isTampered"),
  authenticityScore: varchar("authenticityScore", { length: 10 }),
  verificationNotes: text("verificationNotes"),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("kyc_docs_app_idx").on(t.applicationId),
]);

export const livenessChecks = pgTable("liveness_checks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  applicationId: varchar("applicationId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  status: livenessStatusEnum("status").default("not_started").notNull(),
  sessionToken: varchar("sessionToken", { length: 256 }),
  livenessScore: varchar("livenessScore", { length: 10 }),
  faceMatchScore: varchar("faceMatchScore", { length: 10 }),
  spoofingDetected: boolean("spoofingDetected").default(false),
  frameCount: integer("frameCount").default(0),
  challengeType: varchar("challengeType", { length: 50 }),
  challengeCompleted: boolean("challengeCompleted").default(false),
  analysisResult: jsonb("analysisResult"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("liveness_app_idx").on(t.applicationId),
]);

export type KycApplication = typeof kycApplications.$inferSelect;
export type InsertKycApplication = typeof kycApplications.$inferInsert;
export type KycDocument = typeof kycDocuments.$inferSelect;
export type LivenessCheck = typeof livenessChecks.$inferSelect;

// ── Cart sessions & items ─────────────────────────────────────────────────────
export const cartSessions = pgTable("cart_sessions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerId: varchar("customerId", { length: 36 }),
  waPhoneNumber: varchar("waPhoneNumber", { length: 20 }),
  sessionData: jsonb("sessionData").notNull().default({}),
  currentStep: varchar("currentStep", { length: 50 }).default("greeting"),
  language: varchar("language", { length: 20 }).default("english"),
  expiresAt: timestamp("expiresAt").notNull().$defaultFn(() => new Date(Date.now() + 86400000)),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
}, (t) => [
  index("cart_sessions_tenant_idx").on(t.tenantId),
  index("cart_sessions_phone_idx").on(t.waPhoneNumber),
  index("cart_sessions_customer_idx").on(t.customerId),
]);

export const cartItems = pgTable("cart_items", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  cartSessionId: varchar("cartSessionId", { length: 36 }).notNull().references(() => cartSessions.id, { onDelete: "cascade" }),
  productId: varchar("productId", { length: 36 }).notNull(),
  productName: varchar("productName", { length: 255 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
}, (t) => [
  index("cart_items_session_idx").on(t.cartSessionId),
]);

// ── Refunds ───────────────────────────────────────────────────────────────────
export const refundStatusEnum = pgEnum("refund_status", ["pending", "approved", "rejected", "processed"]);
export const refunds = pgTable("refunds", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: varchar("orderId", { length: 36 }).notNull().references(() => orders.id),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  reason: text("reason"),
  status: refundStatusEnum("status").notNull().default("pending"),
  processedAt: timestamp("processedAt"),
  // === W30 escrow-lifecycle === (verify-v1 #9: provider refund execution)
  providerReference: varchar("providerReference", { length: 256 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
}, (t) => [
  index("refunds_order_idx").on(t.orderId),
  index("refunds_tenant_idx").on(t.tenantId),
  index("refunds_status_idx").on(t.status),
]);

// ── Invoices ──────────────────────────────────────────────────────────────────
export const invoiceTypeEnum = pgEnum("invoice_type", ["subscription", "profit_share", "one_time"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "sent", "paid", "overdue", "cancelled"]);
export const invoices = pgTable("invoices", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  invoiceNumber: varchar("invoiceNumber", { length: 50 }).notNull(),
  type: invoiceTypeEnum("type").notNull().default("subscription"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  periodStart: timestamp("periodStart"),
  periodEnd: timestamp("periodEnd"),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  commissionRate: numeric("commissionRate", { precision: 5, scale: 4 }),
  commissionAmount: numeric("commissionAmount", { precision: 12, scale: 2 }),
  subscriptionFee: numeric("subscriptionFee", { precision: 12, scale: 2 }),
  totalAmount: numeric("totalAmount", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  pdfUrl: text("pdfUrl"),
  sentAt: timestamp("sentAt"),
  paidAt: timestamp("paidAt"),
  dueDate: timestamp("dueDate"),
  lineItems: jsonb("lineItems").notNull().default([]),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
}, (t) => [
  index("invoices_tenant_idx").on(t.tenantId),
  index("invoices_status_idx").on(t.status),
]);

// ── NLP sessions (WhatsApp buyer conversations) ───────────────────────────────
export const nlpSessions = pgTable("nlp_sessions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  waPhoneNumber: varchar("waPhoneNumber", { length: 20 }).notNull(),
  customerName: varchar("customerName", { length: 255 }),
  language: varchar("language", { length: 20 }).notNull().default("english"),
  state: varchar("state", { length: 50 }).notNull().default("greeting"),
  context: jsonb("context").notNull().default({}),
  messageHistory: jsonb("messageHistory").notNull().default([]),
  cartSessionId: varchar("cartSessionId", { length: 36 }).references(() => cartSessions.id),
  lastActivityAt: timestamp("lastActivityAt").notNull().defaultNow(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
}, (t) => [
  index("nlp_sessions_tenant_idx").on(t.tenantId),
  index("nlp_sessions_phone_idx").on(t.waPhoneNumber),
]);
// ── WhatsApp Media Files ──────────────────────────────────────────────────────
export const whatsappMediaFiles = pgTable("whatsapp_media_files", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: varchar("conversationId", { length: 36 }),
  waPhoneNumber: varchar("waPhoneNumber", { length: 20 }),
  fileName: varchar("fileName", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 128 }).notNull(),
  fileSize: integer("fileSize"),
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  storageUrl: varchar("storageUrl", { length: 1024 }).notNull(),
  documentType: varchar("documentType", { length: 32 }).notNull().default("other"),
  aiScanResult: jsonb("aiScanResult"),
  uploadedAt: timestamp("uploadedAt").notNull().defaultNow(),
}, (t) => [
  index("wa_media_tenant_idx").on(t.tenantId),
  index("wa_media_conversation_idx").on(t.conversationId),
]);
export type WhatsappMediaFile = typeof whatsappMediaFiles.$inferSelect;

// ── Order items (normalised) ──────────────────────────────────────────────────
export const orderItems = pgTable("order_items", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: varchar("orderId", { length: 36 }).notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: varchar("productId", { length: 36 }).notNull(),
  productName: varchar("productName", { length: 255 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
}, (t) => [
  index("order_items_order_idx").on(t.orderId),
  index("order_items_product_idx").on(t.productId),
]);

// ── Type exports ──────────────────────────────────────────────────────────────
export type CartSession = typeof cartSessions.$inferSelect;
export type CartItem = typeof cartItems.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type NlpSession = typeof nlpSessions.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;

// ─── Payment Gateway Configs ─────────────────────────────────────────────────
export const paymentGatewayConfigs = pgTable("payment_gateway_configs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  publicKey: text("publicKey"),
  secretKey: text("secretKey"),
  webhookSecret: text("webhookSecret"),
  callbackUrl: text("callbackUrl"),
  isActive: boolean("isActive").default(true).notNull(),
  metadata: jsonb("metadata"),
  // w11 Universal Provider Framework: non-secret provider extras (manual bank
  // details etc.); secrets stay in the encrypted secretKey/webhookSecret cols.
  credentials: jsonb("credentials"),
  priority: integer("priority").default(0).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("pgc_tenant_idx").on(t.tenantId),
  uniqueIndex("pgc_tenant_provider_idx").on(t.tenantId, t.provider),
]);

export const paymentTransactions = pgTable("payment_transactions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  orderId: varchar("orderId", { length: 36 }),
  customerId: varchar("customerId", { length: 36 }),
  provider: varchar("provider", { length: 32 }).notNull(),
  providerRef: varchar("providerRef", { length: 256 }),
  providerTxId: varchar("providerTxId", { length: 256 }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 8 }).default("NGN").notNull(),
  status: varchar("status", { length: 32 }).default("initiated").notNull(),
  paymentUrl: text("paymentUrl"),
  callbackData: jsonb("callbackData"),
  paidAt: timestamp("paidAt"),
  failureReason: text("failureReason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("ptx_tenant_idx2").on(t.tenantId),
  index("ptx_order_idx2").on(t.orderId),
  index("ptx_status_idx2").on(t.status),
]);

export type PaymentGatewayConfig = typeof paymentGatewayConfigs.$inferSelect;
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;

// ── Alert Rules ───────────────────────────────────────────────────────────────
export const alertRuleTypeEnum = pgEnum("alert_rule_type", [
  "reconciliation_discrepancy",
  "low_stock",
  "failed_payments",
  "model_drift",
  "escalation_count",
]);

export const alertRules = pgTable("alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 128 }).notNull(),
  ruleType: alertRuleTypeEnum("rule_type").notNull(),
  // threshold interpretation per ruleType:
  // reconciliation_discrepancy / failed_payments: percentage 0–100 (e.g. 5 = 5%)
  // low_stock: integer count
  // model_drift: PSI value 0.0–1.0
  threshold: numeric("threshold", { precision: 10, scale: 4 }).notNull().default("5"),
  windowHours: integer("window_hours").notNull().default(24),
  isEnabled: boolean("is_enabled").notNull().default(true),
  notifyOwnerOnTrigger: boolean("notify_owner_on_trigger").notNull().default(true),
  heartbeatTaskUid: varchar("heartbeat_task_uid", { length: 128 }),
  lastTriggeredAt: timestamp("last_triggered_at"),
  // Cooldown: skip notification if rule already fired within this many minutes.
  // 0 = no cooldown (always notify). Default 60 min prevents alert fatigue.
  cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("alert_rules_type_idx").on(t.ruleType),
  index("alert_rules_enabled_idx").on(t.isEnabled),
]);

export type AlertRule = typeof alertRules.$inferSelect;
export type NewAlertRule = typeof alertRules.$inferInsert;

// ─── Alert Rule Events ────────────────────────────────────────────────────────
// Immutable append-only log of each time a rule fires. Written by the heartbeat handler.
export const alertRuleEvents = pgTable("alert_rule_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ruleId: uuid("rule_id").notNull().references(() => alertRules.id, { onDelete: "cascade" }),
  ruleName: varchar("rule_name", { length: 128 }).notNull(),
  ruleType: alertRuleTypeEnum("rule_type").notNull(),
  actualValue: numeric("actual_value", { precision: 10, scale: 4 }).notNull(),
  threshold: numeric("threshold", { precision: 10, scale: 4 }).notNull(),
  windowHours: integer("window_hours").notNull(),
  notificationSent: boolean("notification_sent").notNull().default(false),
  metadata: jsonb("metadata"),
  triggeredAt: timestamp("triggered_at").defaultNow().notNull(),
}, (t) => [
  index("alert_rule_events_rule_id_idx").on(t.ruleId),
  index("alert_rule_events_triggered_at_idx").on(t.triggeredAt),
  index("alert_rule_events_type_idx").on(t.ruleType),
]);
export type AlertRuleEvent = typeof alertRuleEvents.$inferSelect;
export type NewAlertRuleEvent = typeof alertRuleEvents.$inferInsert;

// ─── Forecast Snapshots ───────────────────────────────────────────────────────
// Each month-end the heartbeat saves a projected value for the next month.
// The following month's heartbeat resolves the actual value and computes accuracy.
export const forecastSnapshots = pgTable("forecast_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotMonth: varchar("snapshot_month", { length: 7 }).notNull(), // YYYY-MM being projected
  projectedRevenue: numeric("projected_revenue", { precision: 14, scale: 4 }).notNull(),
  projectedGmv: numeric("projected_gmv", { precision: 14, scale: 4 }).notNull(),
  actualRevenue: numeric("actual_revenue", { precision: 14, scale: 4 }),
  actualGmv: numeric("actual_gmv", { precision: 14, scale: 4 }),
  accuracyPct: numeric("accuracy_pct", { precision: 7, scale: 4 }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("forecast_snapshots_month_idx").on(t.snapshotMonth),
]);
export type ForecastSnapshot = typeof forecastSnapshots.$inferSelect;
export type NewForecastSnapshot = typeof forecastSnapshots.$inferInsert;

// ─── COGS Dispute Requests ────────────────────────────────────────────────────
export const cogsDisputeStatusEnum = pgEnum("cogs_dispute_status", ["pending", "approved", "rejected"]);
export const cogsDisputeRequests = pgTable("cogs_dispute_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id, { onDelete: "cascade" }),
  currentCogsRate: numeric("current_cogs_rate", { precision: 5, scale: 4 }).notNull(),
  requestedCogsRate: numeric("requested_cogs_rate", { precision: 5, scale: 4 }).notNull(),
  justification: text("justification"),
  status: cogsDisputeStatusEnum("status").notNull().default("pending"),
  reviewedBy: varchar("reviewed_by", { length: 128 }),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("cogs_dispute_tenant_idx").on(t.tenantId),
  index("cogs_dispute_status_idx").on(t.status),
]);
export type CogsDisputeRequest = typeof cogsDisputeRequests.$inferSelect;
export type NewCogsDisputeRequest = typeof cogsDisputeRequests.$inferInsert;

// ─── Escrow & Logistics ───────────────────────────────────────────────────────

// Custody mode: PSSP = funds held at partner bank (instruction-only),
//               PSP  = funds held natively in platform wallet engine
export const custodyModeEnum = pgEnum("custody_mode", ["pssp", "psp"]);

// Escrow state machine:
// PAYMENT_RECEIVED → ESCROW_HELD → DELIVERY_CONFIRMED → RELEASE_INSTRUCTED → SETTLED
//                                 ↘ DISPUTE_RAISED → DISPUTE_RESOLVED → REFUNDED | SETTLED
export const escrowStateEnum = pgEnum("escrow_state", [
  "payment_received",
  "escrow_held",
  "delivery_confirmed",
  "release_instructed",
  "settled",
  "dispute_raised",
  "dispute_resolved",
  "refunded",
  "expired",
]);

export const disputeStatusEnum = pgEnum("dispute_status", [
  "open", "under_review", "resolved_merchant", "resolved_buyer", "escalated",
]);

export const disputeResolutionEnum = pgEnum("dispute_resolution", [
  "full_release_to_merchant",
  "full_refund_to_buyer",
  "partial_refund",
  "no_action",
]);

export const shipmentStatusEnum = pgEnum("shipment_status", [
  "pending", "created", "picked_up", "in_transit",
  "out_for_delivery", "delivered", "failed", "returned",
]);

export const walletTxTypeEnum = pgEnum("wallet_tx_type", [
  "escrow_credit",    // funds held in escrow
  "escrow_release",   // escrow released to merchant
  "escrow_refund",    // escrow refunded to buyer
  "float_income",     // PSP: interest earned on held balance
  "withdrawal",       // merchant withdrawal to bank
  "fee_deduction",    // platform fee at settlement
  // === W27 credit (additive enum values; never reorder the above) ===
  "loan_disbursement", // micro-loan principal credited to merchant wallet
  "loan_repayment",    // micro-loan repayment debited from merchant wallet
]);

// ─── Escrow Config (platform-level) ──────────────────────────────────────────
export const escrowConfig = pgTable("escrow_config", {
  id: serial("id").primaryKey(),
  custodyMode: custodyModeEnum("custody_mode").default("pssp").notNull(),
  // PSSP mode: partner bank details
  bankPartnerName: varchar("bank_partner_name", { length: 100 }),
  bankPartnerCode: varchar("bank_partner_code", { length: 20 }),
  bankApiBaseUrl: text("bank_api_base_url"),
  bankApiKeyEncrypted: text("bank_api_key_encrypted"),
  bankEscrowAccountNumber: varchar("bank_escrow_account_number", { length: 20 }),
  // Shipbubble logistics
  shipbubbleApiKey: text("shipbubble_api_key"),
  shipbubbleWebhookSecret: text("shipbubble_webhook_secret"),
  // Escrow rules
  platformFeeRate: numeric("platform_fee_rate", { precision: 6, scale: 4 }).default("0.03125").notNull(),
  buyerConfirmWindowHours: integer("buyer_confirm_window_hours").default(24).notNull(),
  disputeWindowHours: integer("dispute_window_hours").default(48).notNull(),
  autoConfirmEnabled: boolean("auto_confirm_enabled").default(true).notNull(),
  // PSP mode: float income
  floatYieldRate: numeric("float_yield_rate", { precision: 6, scale: 4 }).default("0.08").notNull(),
  // Evidence scan
  minScanConfidence: numeric("min_scan_confidence", { precision: 4, scale: 2 }).default("0.70").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Escrow Transactions ──────────────────────────────────────────────────────
export const escrowTransactions = pgTable("escrow_transactions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: varchar("order_id", { length: 36 }).notNull().references(() => orders.id),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  customerId: varchar("customer_id", { length: 36 }),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  platformFee: numeric("platform_fee", { precision: 14, scale: 2 }).default("0").notNull(),
  netMerchantAmount: numeric("net_merchant_amount", { precision: 14, scale: 2 }).default("0").notNull(),
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  custodyMode: custodyModeEnum("custody_mode").default("pssp").notNull(),
  state: escrowStateEnum("state").default("payment_received").notNull(),
  // PSSP mode: bank instruction tracking
  bankRef: varchar("bank_ref", { length: 128 }),
  bankHoldConfirmedAt: timestamp("bank_hold_confirmed_at"),
  releaseInstructedAt: timestamp("release_instructed_at"),
  bankSettlementConfirmedAt: timestamp("bank_settlement_confirmed_at"),
  // PSP mode: internal wallet IDs
  buyerWalletTxId: varchar("buyer_wallet_tx_id", { length: 36 }),
  merchantWalletTxId: varchar("merchant_wallet_tx_id", { length: 36 }),
  // Delivery confirmation
  shipmentId: varchar("shipment_id", { length: 36 }),
  deliveryConfirmedAt: timestamp("delivery_confirmed_at"),
  buyerConfirmedAt: timestamp("buyer_confirmed_at"),
  autoConfirmed: boolean("auto_confirmed").default(false).notNull(),
  buyerConfirmDeadline: timestamp("buyer_confirm_deadline"),
  // Settlement
  settledAt: timestamp("settled_at"),
  refundedAt: timestamp("refunded_at"),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).unique(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("escrow_order_idx").on(t.orderId),
  index("escrow_tenant_idx").on(t.tenantId),
  index("escrow_state_idx").on(t.state),
  index("escrow_created_idx").on(t.createdAt),
  // === W30 escrow-lifecycle === (mig 0091: SLA scan / auto-confirm selection)
  index("escrow_state_deadline_idx").on(t.state, t.buyerConfirmDeadline),
]);

// ─── Merchant Wallets (PSP mode) ──────────────────────────────────────────────
export const merchantWallets = pgTable("merchant_wallets", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenant_id", { length: 36 }).notNull().unique(),
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  availableBalance: numeric("available_balance", { precision: 14, scale: 2 }).default("0").notNull(),
  escrowBalance: numeric("escrow_balance", { precision: 14, scale: 2 }).default("0").notNull(),
  totalEarned: numeric("total_earned", { precision: 14, scale: 2 }).default("0").notNull(),
  totalWithdrawn: numeric("total_withdrawn", { precision: 14, scale: 2 }).default("0").notNull(),
  custodyMode: custodyModeEnum("custody_mode").default("pssp").notNull(),
  bankAccountName: varchar("bank_account_name", { length: 255 }),
  bankAccountNumber: varchar("bank_account_number", { length: 20 }),
  bankCode: varchar("bank_code", { length: 10 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("wallet_tenant_idx").on(t.tenantId),
]);

// ─── Wallet Transactions ──────────────────────────────────────────────────────
export const walletTransactions = pgTable("wallet_transactions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  walletId: varchar("wallet_id", { length: 36 }).notNull().references(() => merchantWallets.id),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  type: walletTxTypeEnum("type").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  balanceBefore: numeric("balance_before", { precision: 14, scale: 2 }).notNull(),
  balanceAfter: numeric("balance_after", { precision: 14, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  orderId: varchar("order_id", { length: 36 }),
  escrowTxId: varchar("escrow_tx_id", { length: 36 }),
  description: text("description"),
  reference: varchar("reference", { length: 128 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("wallet_tx_wallet_idx").on(t.walletId),
  index("wallet_tx_tenant_idx").on(t.tenantId),
  index("wallet_tx_type_idx").on(t.type),
  index("wallet_tx_created_idx").on(t.createdAt),
  // A1-03: exactly-once withdrawal per (wallet, reference). The client
  // reference is the idempotency key for requestWithdrawal; without this
  // index two concurrent same-reference withdrawals both pass the
  // read-then-check and double-debit the available balance. The loser's
  // insert fails 23505 and is translated into an idempotent replay of the
  // original pending withdrawal.
  uniqueIndex("wallet_tx_wallet_ref_uniq")
    .on(t.walletId, t.reference)
    .where(sql`reference IS NOT NULL`),
]);

// ─── Logistics Shipments ──────────────────────────────────────────────────────
export const logisticsShipments = pgTable("logistics_shipments", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: varchar("order_id", { length: 36 }).notNull().references(() => orders.id),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  escrowTxId: varchar("escrow_tx_id", { length: 36 }),
  provider: varchar("provider", { length: 50 }).default("shipbubble").notNull(),
  carrierId: varchar("carrier_id", { length: 50 }),
  carrierName: varchar("carrier_name", { length: 100 }),
  trackingId: varchar("tracking_id", { length: 128 }),
  trackingUrl: text("tracking_url"),
  status: shipmentStatusEnum("status").default("pending").notNull(),
  // Addresses
  senderName: varchar("sender_name", { length: 255 }),
  senderPhone: varchar("sender_phone", { length: 30 }),
  senderAddress: jsonb("sender_address"),
  recipientName: varchar("recipient_name", { length: 255 }),
  recipientPhone: varchar("recipient_phone", { length: 30 }),
  recipientAddress: jsonb("recipient_address"),
  // Shipment details
  weightKg: numeric("weight_kg", { precision: 6, scale: 2 }),
  shippingFee: numeric("shipping_fee", { precision: 10, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  estimatedDeliveryAt: timestamp("estimated_delivery_at"),
  // Lifecycle timestamps
  createdAtProvider: timestamp("created_at_provider"),
  pickedUpAt: timestamp("picked_up_at"),
  inTransitAt: timestamp("in_transit_at"),
  outForDeliveryAt: timestamp("out_for_delivery_at"),
  deliveredAt: timestamp("delivered_at"),
  failedAt: timestamp("failed_at"),
  returnedAt: timestamp("returned_at"),
  // 4-digit PIN the rider must collect from the buyer at handover
  // (see logistics.createShipment / simulateDelivery). W30 (V3#17): stores
  // the keyed HMAC-SHA256 hash ("pinv1:"+64hex), widened to 80 in 0097.
  deliveryPin: varchar("delivery_pin", { length: 80 }),
  // Webhook audit trail (array of raw payloads)
  webhookPayloads: jsonb("webhook_payloads").default([]).notNull(),
  providerResponse: jsonb("provider_response"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("shipment_order_idx").on(t.orderId),
  index("shipment_tenant_idx").on(t.tenantId),
  index("shipment_status_idx").on(t.status),
  index("shipment_tracking_idx").on(t.trackingId),
]);

// ─── Escrow Disputes ─────────────────────────────────────────────────────────
export const escrowDisputes = pgTable("escrow_disputes", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  escrowTxId: varchar("escrow_tx_id", { length: 36 }).notNull().references(() => escrowTransactions.id),
  orderId: varchar("order_id", { length: 36 }).notNull(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  raisedBy: varchar("raised_by", { length: 30 }).default("buyer").notNull(), // buyer | merchant
  reason: varchar("reason", { length: 100 }).notNull(), // not_received, wrong_item, damaged, partial_delivery
  description: text("description"),
  status: disputeStatusEnum("status").default("open").notNull(),
  resolution: disputeResolutionEnum("resolution"),
  refundAmount: numeric("refund_amount", { precision: 14, scale: 2 }),
  // Evidence
  buyerEvidence: jsonb("buyer_evidence"),   // { text, imageUrls[], submittedAt }
  merchantEvidence: jsonb("merchant_evidence"),
  // Resolution
  resolvedBy: varchar("resolved_by", { length: 128 }),
  resolverNotes: text("resolver_notes"),
  buyerResponseDeadline: timestamp("buyer_response_deadline"),
  merchantResponseDeadline: timestamp("merchant_response_deadline"),
  resolvedAt: timestamp("resolved_at"),
  escalatedAt: timestamp("escalated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("dispute_escrow_idx").on(t.escrowTxId),
  index("dispute_order_idx").on(t.orderId),
  index("dispute_tenant_idx").on(t.tenantId),
  index("dispute_status_idx").on(t.status),
]);

// ─── Float Income Ledger (PSP mode) ──────────────────────────────────────────
export const floatIncomeEntries = pgTable("float_income_entries", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
  totalEscrowBalance: numeric("total_escrow_balance", { precision: 16, scale: 2 }).notNull(),
  dailyYieldRate: numeric("daily_yield_rate", { precision: 10, scale: 8 }).notNull(),
  incomeAmount: numeric("income_amount", { precision: 14, scale: 4 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("float_income_date_idx").on(t.date),
  // W30 (V3#13): at most one accrual per day — repeat runs conflict, never double-accrue.
  uniqueIndex("float_income_date_uniq").on(t.date),
]);

// ─── Type Exports ─────────────────────────────────────────────────────────────
export type EscrowConfig = typeof escrowConfig.$inferSelect;
export type EscrowTransaction = typeof escrowTransactions.$inferSelect;
export type NewEscrowTransaction = typeof escrowTransactions.$inferInsert;
export type MerchantWallet = typeof merchantWallets.$inferSelect;
export type NewMerchantWallet = typeof merchantWallets.$inferInsert;
export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
export type LogisticsShipment = typeof logisticsShipments.$inferSelect;
export type NewLogisticsShipment = typeof logisticsShipments.$inferInsert;
export type EscrowDispute = typeof escrowDisputes.$inferSelect;
export type NewEscrowDispute = typeof escrowDisputes.$inferInsert;
export type FloatIncomeEntry = typeof floatIncomeEntries.$inferSelect;

// ─── Merchant Notifications ───────────────────────────────────────────────────
export const notificationTypeEnum = pgEnum("notification_type", [
  "escrow_held",
  "delivery_confirmed",
  "escrow_settled",
  "escrow_refunded",
  "dispute_opened",
  "dispute_resolved",
  "withdrawal_processed",
  "shipment_update",
  "system",
  "cod_discrepancy",
  "cod_delivery_failed",
]);

export const merchantNotifications = pgTable("merchant_notifications", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  type: notificationTypeEnum("type").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body").notNull(),
  metadata: jsonb("metadata"),
  read: boolean("read").default(false).notNull(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("notif_tenant_idx").on(t.tenantId),
  index("notif_read_idx").on(t.tenantId, t.read),
  index("notif_created_idx").on(t.createdAt),
]);

export type MerchantNotification = typeof merchantNotifications.$inferSelect;
export type NewMerchantNotification = typeof merchantNotifications.$inferInsert;

// ─── Escrow Timeline Attachments ─────────────────────────────────────────────
export const timelineAttachmentTypeEnum = pgEnum("timeline_attachment_type", ["document", "note"]);

export const escrowTimelineAttachments = pgTable("escrow_timeline_attachments", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  escrowId: varchar("escrow_id", { length: 36 }).notNull(),
  // eventId is a client-generated stable ID for the timeline event (e.g. "escrow-held", "shipment-created")
  eventId: varchar("event_id", { length: 128 }).notNull(),
  attachmentType: timelineAttachmentTypeEnum("attachment_type").notNull().default("document"),
  fileUrl: text("file_url"),
  fileKey: text("file_key"),
  filename: varchar("filename", { length: 255 }),
  mimeType: varchar("mime_type", { length: 128 }),
  note: text("note"),
  uploadedBy: varchar("uploaded_by", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("eta_escrow_idx").on(t.escrowId),
  index("eta_event_idx").on(t.escrowId, t.eventId),
]);
export type EscrowTimelineAttachment = typeof escrowTimelineAttachments.$inferSelect;
export type NewEscrowTimelineAttachment = typeof escrowTimelineAttachments.$inferInsert;

// ─── Merchant Onboarding Progress ────────────────────────────────────────────
export const merchantOnboardingProgress = pgTable("merchant_onboarding_progress", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenant_id", { length: 36 }).notNull().unique(),
  currentStep: integer("current_step").notNull().default(0),
  completedSteps: jsonb("completed_steps").notNull().default([]),
  stepData: jsonb("step_data").notNull().default({}),
  isCompleted: boolean("is_completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("merchant_onboarding_tenant_idx").on(t.tenantId),
]);
export type MerchantOnboardingProgress = typeof merchantOnboardingProgress.$inferSelect;
export type NewMerchantOnboardingProgress = typeof merchantOnboardingProgress.$inferInsert;

// ─── Escrow SLA Config ────────────────────────────────────────────────────────
export const escrowSlaConfig = pgTable("escrow_sla_config", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenant_id", { length: 36 }),
  releaseDeadlineHours: integer("release_deadline_hours").notNull().default(72),
  warningHours: integer("warning_hours").notNull().default(24),
  autoReleaseEnabled: boolean("auto_release_enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("sla_tenant_idx").on(t.tenantId),
]);
export type EscrowSlaConfig = typeof escrowSlaConfig.$inferSelect;

// ─── Dispute Evidence Tokens ──────────────────────────────────────────────────
export const disputeEvidenceTokens = pgTable("dispute_evidence_tokens", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  token: varchar("token", { length: 64 }).notNull().unique(),
  disputeId: varchar("dispute_id", { length: 36 }).notNull(),
  buyerPhone: varchar("buyer_phone", { length: 32 }),
  buyerName: varchar("buyer_name", { length: 128 }),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("det_token_idx").on(t.token),
  index("det_dispute_idx").on(t.disputeId),
]);
export type DisputeEvidenceToken = typeof disputeEvidenceTokens.$inferSelect;

// ─── Dispute Evidence Submissions ────────────────────────────────────────────
export const disputeEvidenceSubmissions = pgTable("dispute_evidence_submissions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  disputeId: varchar("dispute_id", { length: 36 }).notNull(),
  token: varchar("token", { length: 64 }).notNull(),
  fileUrl: text("file_url"),
  fileKey: text("file_key"),
  filename: varchar("filename", { length: 255 }),
  mimeType: varchar("mime_type", { length: 128 }),
  note: text("note"),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (t) => [
  index("des_dispute_idx").on(t.disputeId),
  index("des_token_idx").on(t.token),
]);
export type DisputeEvidenceSubmission = typeof disputeEvidenceSubmissions.$inferSelect;


// ── Escrow SLA Extension Requests ────────────────────────────────────────────
export const slaExtensionStatusEnum = pgEnum("sla_extension_status", [
  "pending", "approved", "rejected", "expired",
]);

export const escrowSlaExtensions = pgTable("escrow_sla_extensions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  escrowId: varchar("escrow_id", { length: 36 }).notNull().references(() => escrowTransactions.id),
  requestedByTenantId: varchar("requested_by_tenant_id", { length: 36 }).notNull(),
  extensionHours: integer("extension_hours").notNull().default(24),
  reason: text("reason"),
  status: slaExtensionStatusEnum("status").notNull().default("pending"),
  buyerToken: varchar("buyer_token", { length: 64 }).notNull().unique(),
  buyerPhone: varchar("buyer_phone", { length: 30 }),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  respondedAt: timestamp("responded_at"),
  expiresAt: timestamp("expires_at").notNull(),
  newDeadline: timestamp("new_deadline"),
}, (t) => [
  index("sla_ext_escrow_idx").on(t.escrowId),
  index("sla_ext_token_idx").on(t.buyerToken),
]);
export type EscrowSlaExtension = typeof escrowSlaExtensions.$inferSelect;

// ── Operator-level WhatsApp Message Templates ─────────────────────────────
export const operatorTemplateCategoryEnum = pgEnum("operator_template_category", [
  "transactional", "marketing", "utility", "authentication", "custom",
]);

export const operatorTemplates = pgTable("operator_templates", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: varchar("name", { length: 255 }).notNull().unique(),
  category: operatorTemplateCategoryEnum("category").default("transactional").notNull(),
  language: varchar("language", { length: 10 }).default("en").notNull(),
  headerText: varchar("headerText", { length: 255 }),
  bodyText: text("bodyText").notNull(),
  footerText: varchar("footerText", { length: 255 }),
  variables: jsonb("variables").$type<string[]>(),
  isActive: boolean("isActive").default(true).notNull(),
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("op_tmpl_category_idx").on(t.category),
  index("op_tmpl_active_idx").on(t.isActive),
]);

export type OperatorTemplate = typeof operatorTemplates.$inferSelect;
export type InsertOperatorTemplate = typeof operatorTemplates.$inferInsert;

// ── Offline Message Queue ─────────────────────────────────────────────────
// Stores messages sent while a buyer was offline (2G/no-signal) for replay
export const offlineMsgStatusEnum = pgEnum("offline_msg_status", ["queued", "delivered", "failed"]);
export const offlineMessageQueue = pgTable("offline_message_queue", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: varchar("sessionId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  waPhoneNumber: varchar("waPhoneNumber", { length: 30 }).notNull(),
  message: text("message").notNull(),
  direction: varchar("direction", { length: 10 }).default("outbound").notNull(),
  status: offlineMsgStatusEnum("status").default("queued").notNull(),
  queuedAt: timestamp("queuedAt").defaultNow().notNull(),
  deliveredAt: timestamp("deliveredAt"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
}, (t) => [
  index("omq_session_idx").on(t.sessionId),
  index("omq_phone_idx").on(t.waPhoneNumber),
  index("omq_status_idx").on(t.status),
]);
export type OfflineMessage = typeof offlineMessageQueue.$inferSelect;

// ── WhatsApp Webhook Dead-Letter Queue ────────────────────────────────────────
// Logs every inbound Meta webhook payload with processing status for replay/audit
export const waWebhookStatusEnum = pgEnum("wa_webhook_status", ["received", "processed", "failed", "retried", "dead"]);
export const waWebhookEvents = pgTable("wa_webhook_events", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: varchar("messageId", { length: 128 }),
  phoneNumberId: varchar("phoneNumberId", { length: 64 }),
  waPhoneNumber: varchar("waPhoneNumber", { length: 30 }),
  messageType: varchar("messageType", { length: 30 }),
  rawPayload: jsonb("rawPayload").notNull(),
  status: waWebhookStatusEnum("status").default("received").notNull(),
  retryCount: integer("retryCount").default(0).notNull(),
  lastError: text("lastError"),
  processedAt: timestamp("processedAt"),
  nextRetryAt: timestamp("nextRetryAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("wa_wh_status_idx").on(t.status),
  index("wa_wh_phone_idx").on(t.waPhoneNumber),
  index("wa_wh_retry_idx").on(t.nextRetryAt),
]);
export type WaWebhookEvent = typeof waWebhookEvents.$inferSelect;
export type InsertWaWebhookEvent = typeof waWebhookEvents.$inferInsert;

// ── B2B Module ────────────────────────────────────────────────────────────────
export const buyerTypeEnum = pgEnum("buyer_type", ["retail", "wholesale", "distributor", "government"]);
export const rfqStatusEnum = pgEnum("rfq_status", ["draft", "submitted", "quoted", "accepted", "rejected", "expired"]);
export const poStatusEnum = pgEnum("po_status", ["draft", "submitted", "approved", "rejected", "fulfilled", "cancelled"]);

export const wholesalePriceTiers = pgTable("wholesale_price_tiers", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  productId: varchar("productId", { length: 36 }).notNull(),
  buyerType: buyerTypeEnum("buyerType").notNull(),
  minQuantity: integer("minQuantity").notNull().default(1),
  maxQuantity: integer("maxQuantity"),
  unitPrice: varchar("unitPrice", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  discountPercent: varchar("discountPercent", { length: 10 }),
  paymentTermsDays: integer("paymentTermsDays").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("wholesale_tiers_product_idx").on(t.productId),
  index("wholesale_tiers_tenant_idx").on(t.tenantId),
]);

export const b2bRfq = pgTable("b2b_rfq", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  buyerPhone: varchar("buyerPhone", { length: 30 }).notNull(),
  buyerName: varchar("buyerName", { length: 128 }),
  buyerType: buyerTypeEnum("buyerType").notNull().default("wholesale"),
  items: jsonb("items").notNull(),
  totalEstimate: varchar("totalEstimate", { length: 20 }),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: rfqStatusEnum("status").notNull().default("submitted"),
  quotedPrice: varchar("quotedPrice", { length: 20 }),
  quotedAt: timestamp("quotedAt"),
  expiresAt: timestamp("expiresAt"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("b2b_rfq_tenant_idx").on(t.tenantId),
  index("b2b_rfq_status_idx").on(t.status),
  index("b2b_rfq_buyer_phone_idx").on(t.buyerPhone),
]);

export const b2bPurchaseOrders = pgTable("b2b_purchase_orders", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  poNumber: varchar("poNumber", { length: 32 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  rfqId: varchar("rfqId", { length: 36 }),
  buyerPhone: varchar("buyerPhone", { length: 30 }).notNull(),
  buyerName: varchar("buyerName", { length: 128 }),
  buyerType: buyerTypeEnum("buyerType").notNull().default("wholesale"),
  items: jsonb("items").notNull(),
  totalAmount: varchar("totalAmount", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  paymentTermsDays: integer("paymentTermsDays").default(0),
  dueDate: timestamp("dueDate"),
  status: poStatusEnum("status").notNull().default("submitted"),
  approvedBy: varchar("approvedBy", { length: 36 }),
  approvedAt: timestamp("approvedAt"),
  deliveryAddress: jsonb("deliveryAddress"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("b2b_po_tenant_idx").on(t.tenantId),
  index("b2b_po_status_idx").on(t.status),
]);

// ── Multi-Channel ─────────────────────────────────────────────────────────────
export const channelEnum = pgEnum("channel", ["whatsapp", "ussd", "sms", "telegram", "instagram", "email"]);

export const ussdSessions = pgTable("ussd_sessions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: varchar("sessionId", { length: 128 }).notNull().unique(),
  phoneNumber: varchar("phoneNumber", { length: 30 }).notNull(),
  serviceCode: varchar("serviceCode", { length: 20 }),
  tenantId: varchar("tenantId", { length: 36 }),
  currentMenu: varchar("currentMenu", { length: 64 }).default("greeting"),
  menuHistory: jsonb("menuHistory").default([]),
  nlpSessionId: varchar("nlpSessionId", { length: 36 }),
  isActive: boolean("isActive").default(true).notNull(),
  lastInput: text("lastInput"),
  lastResponse: text("lastResponse"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("ussd_sessions_phone_idx").on(t.phoneNumber),
]);

export const channelMessages = pgTable("channel_messages", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  channel: channelEnum("channel").notNull(),
  direction: varchar("direction", { length: 10 }).notNull().default("inbound"),
  fromAddress: varchar("fromAddress", { length: 128 }).notNull(),
  toAddress: varchar("toAddress", { length: 128 }),
  tenantId: varchar("tenantId", { length: 36 }),
  body: text("body").notNull(),
  metadata: jsonb("metadata"),
  processed: boolean("processed").default(false).notNull(),
  nlpResponse: text("nlpResponse"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("channel_messages_tenant_idx").on(t.tenantId),
  index("channel_messages_channel_idx").on(t.channel),
  index("channel_messages_created_idx").on(t.createdAt),
]);

// ── Marketplace ───────────────────────────────────────────────────────────────
export const sellerStatusEnum = pgEnum("seller_status", ["pending", "active", "suspended", "rejected"]);

export const marketplaceSellers = pgTable("marketplace_sellers", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  businessName: varchar("businessName", { length: 128 }).notNull(),
  ownerPhone: varchar("ownerPhone", { length: 30 }).notNull(),
  ownerName: varchar("ownerName", { length: 128 }),
  email: varchar("email", { length: 256 }),
  category: varchar("category", { length: 64 }),
  commissionRate: varchar("commissionRate", { length: 10 }).notNull().default("10.00"),
  status: sellerStatusEnum("status").notNull().default("pending"),
  kycVerified: boolean("kycVerified").default(false).notNull(),
  bankAccount: jsonb("bankAccount"),
  totalSales: varchar("totalSales", { length: 20 }).default("0.00"),
  totalCommission: varchar("totalCommission", { length: 20 }).default("0.00"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("marketplace_sellers_tenant_idx").on(t.tenantId),
  index("marketplace_sellers_status_idx").on(t.status),
  index("marketplace_sellers_owner_phone_idx").on(t.ownerPhone),
]);

export const sellerProducts = pgTable("seller_products", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  sellerId: varchar("sellerId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  description: text("description"),
  price: varchar("price", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  stockQuantity: integer("stockQuantity").notNull().default(0),
  category: varchar("category", { length: 64 }),
  images: jsonb("images").default([]),
  isApproved: boolean("isApproved").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("seller_products_seller_idx").on(t.sellerId),
  index("seller_products_tenant_idx").on(t.tenantId),
]);

export const marketplaceCommissions = pgTable("marketplace_commissions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  sellerId: varchar("sellerId", { length: 36 }).notNull(),
  orderId: varchar("orderId", { length: 36 }).notNull(),
  saleAmount: varchar("saleAmount", { length: 20 }).notNull(),
  commissionRate: varchar("commissionRate", { length: 10 }).notNull(),
  commissionAmount: varchar("commissionAmount", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  settledAt: timestamp("settledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("marketplace_commissions_seller_idx").on(t.sellerId),
  index("marketplace_commissions_order_idx").on(t.orderId),
  index("marketplace_commissions_status_idx").on(t.status),
  // W30 (V3#12): exactly one commission row per order.
  uniqueIndex("marketplace_commissions_order_uniq").on(t.orderId),
]);

// ── Cross-Border / Mobile Money ───────────────────────────────────────────────
export const momoProviderEnum = pgEnum("momo_provider", ["mtn_momo", "airtel_money", "mpesa", "orange_money", "wave"]);
export const momoStatusEnum = pgEnum("momo_status", ["initiated", "pending", "successful", "failed", "cancelled", "refunded"]);

export const mobileMoneyTransactions = pgTable("mobile_money_transactions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  orderId: varchar("orderId", { length: 36 }),
  provider: momoProviderEnum("provider").notNull(),
  externalRef: varchar("externalRef", { length: 128 }),
  phoneNumber: varchar("phoneNumber", { length: 30 }).notNull(),
  amount: varchar("amount", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: momoStatusEnum("status").notNull().default("initiated"),
  providerResponse: jsonb("providerResponse"),
  callbackPayload: jsonb("callbackPayload"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("mobile_money_tenant_idx").on(t.tenantId),
  index("mobile_money_status_idx").on(t.status),
  index("mobile_money_extref_idx").on(t.externalRef),
  index("mobile_money_order_idx").on(t.orderId),
]);

export const forexRates = pgTable("forex_rates", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  baseCurrency: varchar("baseCurrency", { length: 3 }).notNull(),
  quoteCurrency: varchar("quoteCurrency", { length: 3 }).notNull(),
  rate: varchar("rate", { length: 20 }).notNull(),
  source: varchar("source", { length: 64 }).default("manual"),
  fetchedAt: timestamp("fetchedAt").defaultNow().notNull(),
});

// ── Service Commerce ──────────────────────────────────────────────────────────
export const serviceTypeEnum = pgEnum("service_type", ["appointment", "digital", "subscription", "physical"]);
export const appointmentStatusEnum = pgEnum("appointment_status", ["scheduled", "confirmed", "completed", "cancelled", "no_show"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["active", "paused", "cancelled", "expired", "trial"]);

export const serviceCatalog = pgTable("service_catalog", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  description: text("description"),
  serviceType: serviceTypeEnum("serviceType").notNull(),
  price: varchar("price", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  duration: integer("duration"),
  maxBookingsPerSlot: integer("maxBookingsPerSlot").default(1),
  availableSlots: jsonb("availableSlots").default([]),
  downloadUrl: text("downloadUrl"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const appointments = pgTable("appointments", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  serviceId: varchar("serviceId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 30 }).notNull(),
  customerName: varchar("customerName", { length: 128 }),
  scheduledAt: timestamp("scheduledAt").notNull(),
  durationMinutes: integer("durationMinutes").default(60),
  status: appointmentStatusEnum("status").notNull().default("scheduled"),
  notes: text("notes"),
  reminderSent: boolean("reminderSent").default(false),
  paymentStatus: varchar("paymentStatus", { length: 20 }).default("unpaid"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("appointments_tenant_idx").on(t.tenantId),
  index("appointments_status_idx").on(t.status),
  index("appointments_customer_phone_idx").on(t.customerPhone),
]);

export const digitalProducts = pgTable("digital_products", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  description: text("description"),
  price: varchar("price", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  fileKey: varchar("fileKey", { length: 256 }),
  fileUrl: text("fileUrl"),
  mimeType: varchar("mimeType", { length: 128 }),
  downloadLimit: integer("downloadLimit").default(3),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const digitalProductPurchases = pgTable("digital_product_purchases", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  productId: varchar("productId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 30 }).notNull(),
  downloadToken: varchar("downloadToken", { length: 64 }).notNull().unique(),
  downloadsUsed: integer("downloadsUsed").default(0).notNull(),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("dpp_product_idx").on(t.productId),
  index("dpp_customer_phone_idx").on(t.customerPhone),
]);

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  serviceId: varchar("serviceId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 30 }).notNull(),
  customerName: varchar("customerName", { length: 128 }),
  status: subscriptionStatusEnum("status").notNull().default("active"),
  billingCycle: varchar("billingCycle", { length: 20 }).notNull().default("monthly"),
  amount: varchar("amount", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  currentPeriodStart: timestamp("currentPeriodStart").notNull(),
  currentPeriodEnd: timestamp("currentPeriodEnd").notNull(),
  cancelledAt: timestamp("cancelledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("subscriptions_tenant_idx").on(t.tenantId),
  index("subscriptions_status_idx").on(t.status),
]);

// ── Analytics BI ──────────────────────────────────────────────────────────────
export const cohortSnapshots = pgTable("cohort_snapshots", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  cohortMonth: varchar("cohortMonth", { length: 7 }).notNull(),
  totalCustomers: integer("totalCustomers").notNull().default(0),
  retentionByMonth: jsonb("retentionByMonth").default({}),
  avgOrderValue: varchar("avgOrderValue", { length: 20 }),
  totalRevenue: varchar("totalRevenue", { length: 20 }),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
});

export const ltvScores = pgTable("ltv_scores", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 30 }).notNull(),
  predictedLtv: varchar("predictedLtv", { length: 20 }).notNull(),
  historicalRevenue: varchar("historicalRevenue", { length: 20 }).notNull(),
  orderCount: integer("orderCount").notNull().default(0),
  avgOrderValue: varchar("avgOrderValue", { length: 20 }),
  segment: varchar("segment", { length: 20 }).default("medium"),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
});

export const churnPredictions = pgTable("churn_predictions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 30 }).notNull(),
  churnScore: varchar("churnScore", { length: 10 }).notNull(),
  riskLevel: varchar("riskLevel", { length: 10 }).notNull().default("medium"),
  daysSinceLastOrder: integer("daysSinceLastOrder"),
  predictedChurnDate: timestamp("predictedChurnDate"),
  interventionSent: boolean("interventionSent").default(false),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
});

// ── Compliance / B2G ──────────────────────────────────────────────────────────
export const taxFilingStatusEnum = pgEnum("tax_filing_status", ["draft", "submitted", "accepted", "rejected", "under_review"]);
export const procurementBidStatusEnum = pgEnum("procurement_bid_status", ["draft", "submitted", "shortlisted", "awarded", "rejected", "withdrawn"]);

export const taxFilings = pgTable("tax_filings", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  filingType: varchar("filingType", { length: 32 }).notNull().default("vat"),
  taxAuthority: varchar("taxAuthority", { length: 32 }).notNull().default("firs"),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  grossRevenue: varchar("grossRevenue", { length: 20 }).notNull(),
  taxableAmount: varchar("taxableAmount", { length: 20 }).notNull(),
  taxAmount: varchar("taxAmount", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: taxFilingStatusEnum("status").notNull().default("draft"),
  referenceNumber: varchar("referenceNumber", { length: 64 }),
  submittedAt: timestamp("submittedAt"),
  documents: jsonb("documents").default([]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const cacRegistrations = pgTable("cac_registrations", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  businessName: varchar("businessName", { length: 256 }).notNull(),
  businessType: varchar("businessType", { length: 64 }).notNull().default("sole_proprietorship"),
  rcNumber: varchar("rcNumber", { length: 32 }),
  tinNumber: varchar("tinNumber", { length: 32 }),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  documents: jsonb("documents").default([]),
  submittedAt: timestamp("submittedAt"),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const procurementBids = pgTable("procurement_bids", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  contractTitle: varchar("contractTitle", { length: 256 }).notNull(),
  procuringEntity: varchar("procuringEntity", { length: 256 }).notNull(),
  contractValue: varchar("contractValue", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: procurementBidStatusEnum("status").notNull().default("draft"),
  deadline: timestamp("deadline"),
  documents: jsonb("documents").default([]),
  technicalProposal: text("technicalProposal"),
  financialProposal: text("financialProposal"),
  submittedAt: timestamp("submittedAt"),
  awardedAt: timestamp("awardedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const governmentContracts = pgTable("government_contracts", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  bidId: varchar("bidId", { length: 36 }),
  contractNumber: varchar("contractNumber", { length: 64 }).notNull(),
  procuringEntity: varchar("procuringEntity", { length: 256 }).notNull(),
  contractValue: varchar("contractValue", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  startDate: timestamp("startDate"),
  endDate: timestamp("endDate"),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  milestones: jsonb("milestones").default([]),
  invoicesRaised: integer("invoicesRaised").default(0),
  amountPaid: varchar("amountPaid", { length: 20 }).default("0.00"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

// ── Unified Onboarding & Integration Provisioning ────────────────────────────
export const integrationTypeEnum = pgEnum("integration_type", [
  "medusa", "twenty_crm", "odoo_erp", "africa_talking", "mtn_momo", "mpesa",
  "paystack", "stripe", "chatwoot", "keycloak", "shipbubble", "custom"
]);
export const provisioningStatusEnum = pgEnum("provisioning_status", [
  "pending", "in_progress", "completed", "failed", "skipped"
]);
export const tenantIntegrationStatusEnum = pgEnum("tenant_integration_status", [
  "not_configured", "pending", "active", "error", "disabled"
]);

export const tenantIntegrations = pgTable("tenant_integrations", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  integrationType: integrationTypeEnum("integrationType").notNull(),
  status: tenantIntegrationStatusEnum("status").default("not_configured").notNull(),
  displayName: varchar("displayName", { length: 128 }),
  baseUrl: varchar("baseUrl", { length: 512 }),
  apiKey: text("apiKey"),
  apiSecret: text("apiSecret"),
  webhookSecret: text("webhookSecret"),
  config: jsonb("config").default({}),
  lastHealthCheck: timestamp("lastHealthCheck"),
  lastHealthStatus: varchar("lastHealthStatus", { length: 32 }),
  lastError: text("lastError"),
  enabledAt: timestamp("enabledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("tenant_integrations_tenant_idx").on(t.tenantId),
  uniqueIndex("tenant_integrations_unique_idx").on(t.tenantId, t.integrationType),
]);
export type TenantIntegration = typeof tenantIntegrations.$inferSelect;

export const provisioningJobs = pgTable("provisioning_jobs", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  integrationType: integrationTypeEnum("integrationType").notNull(),
  status: provisioningStatusEnum("status").default("pending").notNull(),
  stepName: varchar("stepName", { length: 128 }).notNull(),
  stepIndex: integer("stepIndex").default(0).notNull(),
  totalSteps: integer("totalSteps").default(1).notNull(),
  inputPayload: jsonb("inputPayload").default({}),
  outputPayload: jsonb("outputPayload").default({}),
  errorMessage: text("errorMessage"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("provisioning_jobs_tenant_idx").on(t.tenantId),
  index("provisioning_jobs_status_idx").on(t.status),
]);
export type ProvisioningJob = typeof provisioningJobs.$inferSelect;

export const unifiedOnboardingSessions = pgTable("unified_onboarding_sessions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull().unique(),
  currentStep: varchar("currentStep", { length: 64 }).default("welcome").notNull(),
  completedSteps: jsonb("completedSteps").default([]),
  businessProfile: jsonb("businessProfile").default({}),
  whatsappConfig: jsonb("whatsappConfig").default({}),
  crmConfig: jsonb("crmConfig").default({}),
  erpConfig: jsonb("erpConfig").default({}),
  ecommerceConfig: jsonb("ecommerceConfig").default({}),
  channelsConfig: jsonb("channelsConfig").default({}),
  paymentsConfig: jsonb("paymentsConfig").default({}),
  billingConfig: jsonb("billingConfig").default({}),
  isComplete: boolean("isComplete").default(false).notNull(),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("unified_onboarding_tenant_idx").on(t.tenantId),
]);
export type UnifiedOnboardingSession = typeof unifiedOnboardingSessions.$inferSelect;

// ─── Medusa Product Onboarding ────────────────────────────────────────────────
export const medusaOnboardingStatusEnum = pgEnum("medusa_onboarding_status", [
  "draft", "syncing", "synced", "failed"
]);

export const medusaProductOnboarding = pgTable("medusa_product_onboarding", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  // Local platform product reference
  productId: varchar("productId", { length: 36 }),
  // Medusa IDs after sync
  medusaProductId: varchar("medusaProductId", { length: 128 }),
  medusaVariantId: varchar("medusaVariantId", { length: 128 }),
  medusaInventoryItemId: varchar("medusaInventoryItemId", { length: 128 }),
  // Product data snapshot
  title: varchar("title", { length: 256 }).notNull(),
  description: text("description"),
  sku: varchar("sku", { length: 64 }),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 8 }).default("NGN").notNull(),
  stockQuantity: integer("stockQuantity").default(0).notNull(),
  weight: numeric("weight", { precision: 8, scale: 2 }),
  images: jsonb("images").default([]),
  categories: jsonb("categories").default([]),
  tags: jsonb("tags").default([]),
  metadata: jsonb("metadata").default({}),
  status: medusaOnboardingStatusEnum("status").default("draft").notNull(),
  errorMessage: text("errorMessage"),
  syncedAt: timestamp("syncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("medusa_onboarding_tenant_idx").on(t.tenantId),
  index("medusa_onboarding_product_idx").on(t.productId),
]);
export type MedusaProductOnboarding = typeof medusaProductOnboarding.$inferSelect;

// ─── Odoo ↔ Medusa Inventory Bridge ──────────────────────────────────────────
export const odooMedusaBridgeSyncStatusEnum = pgEnum("odoo_medusa_bridge_sync_status", [
  "pending", "syncing", "synced", "conflict", "failed"
]);

export const odooMedusaInventoryBridge = pgTable("odoo_medusa_inventory_bridge", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  // Odoo side
  odooProductId: varchar("odooProductId", { length: 64 }).notNull(),
  odooProductName: varchar("odooProductName", { length: 256 }),
  odooSku: varchar("odooSku", { length: 64 }),
  odooStockQty: numeric("odooStockQty", { precision: 12, scale: 2 }).default("0"),
  odooReservedQty: numeric("odooReservedQty", { precision: 12, scale: 2 }).default("0"),
  odooWarehouse: varchar("odooWarehouse", { length: 128 }),
  // Medusa side
  medusaProductId: varchar("medusaProductId", { length: 128 }),
  medusaVariantId: varchar("medusaVariantId", { length: 128 }),
  medusaInventoryItemId: varchar("medusaInventoryItemId", { length: 128 }),
  medusaStockableQty: integer("medusaStockableQty").default(0),
  // Sync metadata
  syncStatus: odooMedusaBridgeSyncStatusEnum("syncStatus").default("pending").notNull(),
  syncDirection: varchar("syncDirection", { length: 16 }).default("odoo_to_medusa"),
  conflictReason: text("conflictReason"),
  lastSyncedAt: timestamp("lastSyncedAt"),
  lastOdooUpdate: timestamp("lastOdooUpdate"),
  lastMedusaUpdate: timestamp("lastMedusaUpdate"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("odoo_medusa_bridge_tenant_idx").on(t.tenantId),
  index("odoo_medusa_bridge_odoo_idx").on(t.odooProductId),
  index("odoo_medusa_bridge_medusa_idx").on(t.medusaVariantId),
]);
export type OdooMedusaInventoryBridge = typeof odooMedusaInventoryBridge.$inferSelect;

// ─── AI Visual Inventory ──────────────────────────────────────────────────────
export const visualInventoryStatusEnum = pgEnum("visual_inventory_status", [
  "processing", "completed", "failed", "review_needed"
]);

export const visualInventorySessions = pgTable("visual_inventory_sessions", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  userId: varchar("userId", { length: 36 }),
  // Image storage
  imageUrl: text("imageUrl").notNull(),
  imageKey: varchar("imageKey", { length: 256 }),
  // AI analysis results
  status: visualInventoryStatusEnum("status").default("processing").notNull(),
  detectedItems: jsonb("detectedItems").default([]),  // [{label, count, confidence, bbox}]
  totalItemsDetected: integer("totalItemsDetected").default(0),
  vlmAnalysis: text("vlmAnalysis"),  // Raw VLM description
  modelUsed: varchar("modelUsed", { length: 64 }),
  processingMs: integer("processingMs"),
  // Reconciliation
  appliedToInventory: boolean("appliedToInventory").default(false).notNull(),
  appliedAt: timestamp("appliedAt"),
  appliedBy: varchar("appliedBy", { length: 36 }),
  inventoryUpdates: jsonb("inventoryUpdates").default([]),  // [{productId, oldQty, newQty}]
  notes: text("notes"),
  scanLocation: varchar("scanLocation", { length: 256 }),  // shelf/aisle/store location
  // CV-1: capture channel — 'mobile' (dashboard upload) or 'whatsapp' (J85 stock-take).
  source: varchar("source", { length: 32 }).default("mobile").notNull(),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("visual_inventory_tenant_idx").on(t.tenantId),
  index("visual_inventory_status_idx").on(t.status),
]);
export type VisualInventorySession = typeof visualInventorySessions.$inferSelect;

export const visualInventoryMappings = pgTable("visual_inventory_mappings", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  // Maps AI-detected label to a platform product
  detectedLabel: varchar("detectedLabel", { length: 256 }).notNull(),
  productId: varchar("productId", { length: 36 }).notNull(),
  productName: varchar("productName", { length: 256 }),
  confidence: real("confidence").default(1.0),
  isVerified: boolean("isVerified").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("visual_inventory_mapping_tenant_idx").on(t.tenantId),
  uniqueIndex("visual_inventory_mapping_unique_idx").on(t.tenantId, t.detectedLabel),
]);
export type VisualInventoryMapping = typeof visualInventoryMappings.$inferSelect;

// ── Nigerian FMCG Product Taxonomy ────────────────────────────────────────────
export const productTaxonomy = pgTable("product_taxonomy", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  category: varchar("category", { length: 128 }).notNull(),
  subcategory: varchar("subcategory", { length: 128 }),
  brand: varchar("brand", { length: 128 }).notNull(),
  productName: varchar("productName", { length: 256 }).notNull(),
  variants: jsonb("variants").default([]),
  aliases: jsonb("aliases").default([]),
  countryOrigin: varchar("countryOrigin", { length: 64 }).default("Nigeria"),
  isLocal: boolean("isLocal").default(true).notNull(),
  isSachet: boolean("isSachet").default(false).notNull(),
  typicalUnit: varchar("typicalUnit", { length: 64 }).default("unit"),
  isActive: boolean("isActive").default(true).notNull(),
  isCustom: boolean("isCustom").default(false).notNull(),
  tenantId: varchar("tenantId", { length: 36 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("product_taxonomy_category_idx").on(t.category),
  index("product_taxonomy_brand_idx").on(t.brand),
  index("product_taxonomy_tenant_idx").on(t.tenantId),
]);
export type ProductTaxonomy = typeof productTaxonomy.$inferSelect;

// ── Label Studio Configuration ─────────────────────────────────────────────────
export const labelStudioConfigs = pgTable("label_studio_configs", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull().unique(),
  labelStudioUrl: varchar("labelStudioUrl", { length: 512 }),
  apiToken: varchar("apiToken", { length: 256 }),
  projectId: integer("projectId"),
  projectName: varchar("projectName", { length: 256 }),
  autoExport: boolean("autoExport").default(false).notNull(),
  lastExportedAt: timestamp("lastExportedAt"),
  exportedCount: integer("exportedCount").default(0).notNull(),
  isConnected: boolean("isConnected").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("label_studio_tenant_idx").on(t.tenantId),
]);
export type LabelStudioConfig = typeof labelStudioConfigs.$inferSelect;

// ── Visual Inventory Ground-Truth Corrections ──────────────────────────────────
export const visualInventoryCorrections = pgTable("visual_inventory_corrections", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: varchar("sessionId", { length: 36 }).notNull(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  detectedLabel: varchar("detectedLabel", { length: 256 }).notNull(),
  originalCount: integer("originalCount").notNull(),
  correctedCount: integer("correctedCount").notNull(),
  correctedBy: varchar("correctedBy", { length: 36 }),
  boundingBoxes: jsonb("boundingBoxes").default([]),
  exportedToLabelStudio: boolean("exportedToLabelStudio").default(false).notNull(),
  labelStudioTaskId: integer("labelStudioTaskId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("vi_corrections_session_idx").on(t.sessionId),
  index("vi_corrections_tenant_idx").on(t.tenantId),
  index("vi_corrections_exported_idx").on(t.exportedToLabelStudio),
]);
export type VisualInventoryCorrection = typeof visualInventoryCorrections.$inferSelect;

// ── Product Image Collections (for YOLO training dataset) ──────────────────────
export const productImageCollections = pgTable("product_image_collections", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  className: varchar("className", { length: 128 }).notNull(),
  displayName: varchar("displayName", { length: 256 }).notNull(),
  imageUrl: text("imageUrl").notNull(),
  imageKey: text("imageKey").notNull(),
  source: varchar("source", { length: 64 }).default("camera").notNull(),
  notes: text("notes"),
  uploadedBy: varchar("uploadedBy", { length: 36 }),
  usedInTraining: boolean("usedInTraining").default(false).notNull(),
  qualityScore: integer("qualityScore"),
  bbox: jsonb("bbox").$type<{ x: number; y: number; w: number; h: number } | null>().default(null),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("pic_tenant_idx").on(t.tenantId),
  index("pic_class_idx").on(t.className),
  index("pic_training_idx").on(t.usedInTraining),
]);
export type ProductImageCollection = typeof productImageCollections.$inferSelect;

// ── Fine-Tune Run History ─────────────────────────────────────────────────────
export const finetuneRuns = pgTable("finetune_runs", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  endedAt: timestamp("endedAt"),
  exitCode: integer("exitCode"),
  dryRun: boolean("dryRun").default(true).notNull(),
  triggeredBy: varchar("triggeredBy", { length: 128 }).default("ui").notNull(),
  logSnapshot: text("logSnapshot"),
  status: varchar("status", { length: 32 }).default("running").notNull(),
}, (t) => [
  index("ft_runs_started_idx").on(t.startedAt),
  index("ft_runs_status_idx").on(t.status),
]);
export type FinetuneRun = typeof finetuneRuns.$inferSelect;

// ── Dataset Version Snapshots ─────────────────────────────────────────────────
export const datasetSnapshots = pgTable("dataset_snapshots", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  createdBy: varchar("createdBy", { length: 128 }),
  label: varchar("label", { length: 256 }),
  totalImages: integer("totalImages").notNull(),
  bboxImages: integer("bboxImages").notNull(),
  qualityImages: integer("qualityImages").notNull(),
  classStats: jsonb("classStats").$type<Record<string, { total: number; bbox: number; quality: number }>>().notNull(),
  notes: text("notes"),
}, (t) => [
  index("ds_snap_created_idx").on(t.createdAt),
]);
export type DatasetSnapshot = typeof datasetSnapshots.$inferSelect;

// ── Model A/B Tests ───────────────────────────────────────────────────────────
export const modelAbTests = pgTable("model_ab_tests", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  modelName: varchar("modelName", { length: 128 }).notNull(),
  championVersion: varchar("championVersion", { length: 128 }).notNull(),
  challengerVersion: varchar("challengerVersion", { length: 128 }).notNull(),
  trafficSplitPct: integer("trafficSplitPct").default(20).notNull(),
  status: varchar("status", { length: 32 }).default("running").notNull(),
  championRequests: integer("championRequests").default(0).notNull(),
  challengerRequests: integer("challengerRequests").default(0).notNull(),
  championMetric: real("championMetric"),
  challengerMetric: real("challengerMetric"),
  pValue: real("pValue"),
  winner: varchar("winner", { length: 32 }),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  concludedAt: timestamp("concludedAt"),
  notes: text("notes"),
}, (t) => [
  index("ab_model_idx").on(t.modelName),
  index("ab_status_idx").on(t.status),
]);
export type ModelAbTest = typeof modelAbTests.$inferSelect;

// ── WhatsApp Message Delivery Receipts ────────────────────────────────────────
export const waDeliveryStatusEnum = pgEnum("wa_delivery_status", ["sent", "delivered", "read", "failed"]);

export const waMessageDeliveryReceipts = pgTable("wa_message_delivery_receipts", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  waMessageId: varchar("waMessageId", { length: 128 }).notNull(),
  recipientPhone: varchar("recipientPhone", { length: 30 }),
  status: waDeliveryStatusEnum("status").notNull(),
  errorCode: varchar("errorCode", { length: 32 }),
  errorMessage: text("errorMessage"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  rawPayload: jsonb("rawPayload"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("wa_dr_tenant_idx").on(t.tenantId),
  index("wa_dr_msg_idx").on(t.waMessageId),
  index("wa_dr_status_idx").on(t.status),
  index("wa_dr_ts_idx").on(t.timestamp),
]);
export type WaMessageDeliveryReceipt = typeof waMessageDeliveryReceipts.$inferSelect;

// ── Hermes Agent Integration ──────────────────────────────────────────────────
export const hermesConfigs = pgTable("hermes_configs", {
  tenantId: varchar("tenantId", { length: 36 }).primaryKey(),
  hermesAgentUrl: text("hermesAgentUrl"),
  hermesApiKey: text("hermesApiKey"),
  enabledSkills: text("enabledSkills"),
  autoApproveBelow: integer("autoApproveBelow"),
  notifyPhone: varchar("notifyPhone", { length: 30 }),
  woocommerceApiUrl: text("woocommerceApiUrl"),
  woocommerceKey: text("woocommerceKey"),
  woocommerceSecret: text("woocommerceSecret"),
  active: boolean("active").default(true).notNull(),
  tourCompleted: boolean("tourCompleted").default(false).notNull(),
  createdAt: integer("createdAt").notNull(),
  updatedAt: integer("updatedAt").notNull(),
}, (t) => [
  index("hermes_configs_tenant_idx").on(t.tenantId),
]);
export type HermesConfig = typeof hermesConfigs.$inferSelect;

export const hermesEventLog = pgTable("hermes_event_log", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  eventType: varchar("eventType", { length: 64 }).notNull(),
  eventId: varchar("eventId", { length: 36 }),
  skillsTriggered: text("skillsTriggered"),
  success: boolean("success").default(true).notNull(),
  durationMs: integer("durationMs"),
  errorMessage: text("errorMessage"),
  rawPayload: jsonb("rawPayload"),
  createdAt: integer("createdAt").notNull(),
}, (t) => [
  index("hermes_log_tenant_idx").on(t.tenantId),
  index("hermes_log_event_type_idx").on(t.eventType),
  index("hermes_log_created_idx").on(t.createdAt),
]);
export type HermesEventLog = typeof hermesEventLog.$inferSelect;

// W30 (Coder E): + "approved_email_failed" (retryable email-dispatch failure).
export const hermesPOStatusEnum = pgEnum("hermes_po_status", ["pending", "approved", "rejected", "sent", "approved_email_failed"]);
export const hermesPODrafts = pgTable("hermes_po_drafts", {
  poId: varchar("poId", { length: 36 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  supplierName: varchar("supplierName", { length: 128 }).notNull(),
  supplierEmail: varchar("supplierEmail", { length: 256 }).notNull(),
  merchantPhone: varchar("merchantPhone", { length: 30 }),
  sku: varchar("sku", { length: 64 }).notNull(),
  productName: varchar("productName", { length: 256 }).notNull(),
  quantity: integer("quantity").notNull(),
  unitCost: integer("unitCost").notNull(),
  totalCost: integer("totalCost").notNull(),
  currency: varchar("currency", { length: 8 }).default("NGN").notNull(),
  approvalToken: varchar("approvalToken", { length: 32 }).notNull(),
  status: hermesPOStatusEnum("status").default("pending").notNull(),
  note: text("note"),
  approvedBy: varchar("approvedBy", { length: 36 }),
  approvedAt: integer("approvedAt"),
  createdAt: integer("createdAt").notNull(),
}, (t) => [
  index("hermes_po_tenant_idx").on(t.tenantId),
  index("hermes_po_status_idx").on(t.status),
  index("hermes_po_created_idx").on(t.createdAt),
]);
export type HermesPODraft = typeof hermesPODrafts.$inferSelect;

// ── Hermes Layer Health History ───────────────────────────────────────────────
// Stores periodic health snapshots for bridge / skills / router layers.
// Used to render 24-hour sparkline charts on the Hermes Dashboard.
// Rows older than 25 hours are pruned by the heartbeat handler.
export const hermesHealthLog = pgTable("hermes_health_log", {
  id: serial("id").primaryKey(),
  layer: varchar("layer", { length: 32 }).notNull(),   // "bridge" | "skills" | "router"
  online: boolean("online").notNull(),
  latencyMs: integer("latencyMs").notNull().default(0),
  recordedAt: integer("recordedAt").notNull(),          // Unix timestamp (ms)
}, (t) => [
  index("hermes_health_log_layer_idx").on(t.layer),
  index("hermes_health_log_recorded_idx").on(t.recordedAt),
]);
export type HermesHealthLog = typeof hermesHealthLog.$inferSelect;

// ── Phone OTP Sessions ────────────────────────────────────────────────────────
// Stores pending phone OTP verification sessions.
// Used by the phoneAuth tRPC router and the Keycloak WhatsApp OTP SPI.
// Sessions expire after 10 minutes; cleanup is handled by the heartbeat job.
export const phoneOtpSessions = pgTable("phone_otp_sessions", {
  id: varchar("id", { length: 36 }).primaryKey(),          // UUID
  phone: varchar("phone", { length: 30 }).notNull(),        // E.164 format
  otpHash: varchar("otp_hash", { length: 128 }).notNull(),  // bcrypt hash of OTP
  attempts: integer("attempts").default(0).notNull(),       // failed attempts counter
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
  userId: integer("user_id").references(() => users.id),    // optional — link to user
  purpose: varchar("purpose", { length: 32 }).default("login").notNull(), // "login" | "verify"
}, (t) => [
  index("phone_otp_phone_idx").on(t.phone),
  index("phone_otp_expires_idx").on(t.expiresAt),
]);
export type PhoneOtpSession = typeof phoneOtpSessions.$inferSelect;

// ── WhatsApp Notification Log ─────────────────────────────────────────────────
// Persistent record of every outbound WhatsApp order notification.
// The wamid field is populated from the Cloud API response and used to
// correlate delivery receipts from the webhook back to this log row.
export const whatsappNotifStatusEnum = pgEnum("whatsapp_notif_status", [
  "pending",    // queued but not yet sent
  "sent",       // Cloud API accepted (wamid assigned)
  "delivered",  // recipient device confirmed delivery
  "read",       // recipient opened the message
  "failed",     // Cloud API or delivery error
  "simulated",  // simulation mode (no real API call)
  "dead",       // retries exhausted — dead-lettered, admin alerted
]);

export const whatsappNotificationLog = pgTable("whatsapp_notification_log", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: integer("userId").references(() => users.id),          // linked user (if any)
  orderId: varchar("orderId", { length: 36 }),                   // linked order
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),             // E.164 recipient
  notifType: varchar("notifType", { length: 64 }).notNull(),     // "order_confirmation" etc.
  templateName: varchar("templateName", { length: 128 }),
  status: whatsappNotifStatusEnum("status").notNull().default("pending"),
  wamid: varchar("wamid", { length: 128 }),                      // WhatsApp message ID from API
  sentAt: timestamp("sentAt"),
  deliveredAt: timestamp("deliveredAt"),
  readAt: timestamp("readAt"),
  failedAt: timestamp("failedAt"),
  failReason: text("failReason"),
  /** Full Graph API error payload (JSON) for failed deliveries. */
  errorText: text("errorText"),
  /** Per-status receipt timestamps: { sent?, delivered?, read?, failed? }. */
  statusTimestamps: jsonb("statusTimestamps"),
  /** Outbound payload snapshot so failed sends can be retried verbatim. */
  payload: jsonb("payload"),
  /** Retry bookkeeping: attempts made + next scheduled retry (null = none). */
  attempts: integer("attempts").default(0).notNull(),
  nextRetryAt: timestamp("nextRetryAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("wa_notif_log_user_idx").on(t.userId),
  index("wa_notif_log_order_idx").on(t.orderId),
  index("wa_notif_log_tenant_idx").on(t.tenantId),
  index("wa_notif_log_wamid_idx").on(t.wamid),
  index("wa_notif_log_retry_idx").on(t.nextRetryAt),
  index("wa_notif_log_created_idx").on(t.createdAt),
]);
export type WhatsappNotificationLog = typeof whatsappNotificationLog.$inferSelect;

// ── WhatsApp Customer Replies ─────────────────────────────────────────────────
export const whatsappCustomerReplies = pgTable("whatsapp_customer_replies", {
  id:           uuid("id").primaryKey().defaultRandom(),
  tenantId:     text("tenant_id"),
  orderId:      text("order_id"),          // resolved from context_wamid lookup
  userId:       integer("user_id"),        // resolved from phone lookup
  fromPhone:    text("from_phone").notNull(),
  toPhone:      text("to_phone"),
  wamid:        text("wamid").notNull().unique(),
  contextWamid: text("context_wamid"),     // wamid of the notification being replied to
  messageType:  text("message_type").notNull().default("text"), // text | image | audio | document
  body:         text("body"),              // text content
  mediaId:      text("media_id"),          // for media messages
  mediaUrl:     text("media_url"),
  sentiment:    text("sentiment"),         // positive | neutral | negative (optional AI tag)
  read:         boolean("read").notNull().default(false),
  readAt:       timestamp("read_at"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("wacr_from_phone_idx").on(t.fromPhone),
  index("wacr_order_id_idx").on(t.orderId),
  index("wacr_user_id_idx").on(t.userId),
  index("wacr_context_wamid_idx").on(t.contextWamid),
]);

// ── Quick Reply Templates ─────────────────────────────────────────────────────
export const quickReplyTemplates = pgTable("quick_reply_templates", {
  id:         uuid("id").primaryKey().defaultRandom(),
  tenantId:   text("tenant_id"),
  title:      varchar("title", { length: 120 }).notNull(),
  body:       text("body").notNull(),
  category:   varchar("category", { length: 60 }).default("general").notNull(),
  usageCount: integer("usage_count").default(0).notNull(),
  createdBy:  integer("created_by"),   // user.id of the admin who saved it
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("qrt_tenant_idx").on(t.tenantId),
  index("qrt_category_idx").on(t.category),
]);

// ── Temporal Workflow Runs ────────────────────────────────────────────────────
export const temporalWorkflowStatusEnum = pgEnum("temporal_workflow_status", [
  "running", "completed", "failed", "cancelled", "timed_out", "terminated",
]);
export const temporalWorkflowRuns = pgTable("temporal_workflow_runs", {
  id:           uuid("id").primaryKey().defaultRandom(),
  workflowId:   varchar("workflow_id", { length: 128 }).notNull(),
  runId:        varchar("run_id", { length: 128 }).notNull().unique(),
  workflowType: varchar("workflow_type", { length: 128 }).notNull(),
  taskQueue:    varchar("task_queue", { length: 128 }).notNull().default("whatsapp-commerce"),
  tenantId:     varchar("tenant_id", { length: 36 }),
  entityId:     varchar("entity_id", { length: 128 }),
  status:       temporalWorkflowStatusEnum("status").notNull().default("running"),
  input:        jsonb("input"),
  result:       jsonb("result"),
  errorMessage: text("error_message"),
  startedAt:    timestamp("started_at").notNull().defaultNow(),
  closedAt:     timestamp("closed_at"),
  durationMs:   integer("duration_ms"),
}, (t) => [
  index("temporal_runs_workflow_id_idx").on(t.workflowId),
  index("temporal_runs_tenant_idx").on(t.tenantId),
  index("temporal_runs_type_idx").on(t.workflowType),
  index("temporal_runs_status_idx").on(t.status),
  index("temporal_runs_started_idx").on(t.startedAt),
  index("temporal_runs_run_id_idx").on(t.runId),
]);
export type TemporalWorkflowRun = typeof temporalWorkflowRuns.$inferSelect;

// ── Fluvio Event Log ──────────────────────────────────────────────────────────
export const fluvioEventLog = pgTable("fluvio_event_log", {
  id:          uuid("id").primaryKey().defaultRandom(),
  topic:       varchar("topic", { length: 128 }).notNull(),
  offset:      bigint("offset", { mode: "number" }).notNull(),
  partition:   integer("partition").notNull().default(0),
  tenantId:    varchar("tenant_id", { length: 36 }),
  eventType:   varchar("event_type", { length: 128 }),
  payload:     jsonb("payload").notNull(),
  processed:   boolean("processed").notNull().default(false),
  processedAt: timestamp("processed_at"),
  errorMsg:    text("error_msg"),
  receivedAt:  timestamp("received_at").notNull().defaultNow(),
}, (t) => [
  index("fluvio_log_topic_idx").on(t.topic),
  index("fluvio_log_tenant_idx").on(t.tenantId),
  index("fluvio_log_processed_idx").on(t.processed),
  index("fluvio_log_received_idx").on(t.receivedAt),
]);
export type FluvioEventLog = typeof fluvioEventLog.$inferSelect;

// ── TigerBeetle Accounts ──────────────────────────────────────────────────────
export const tigerBeetleAccountTypeEnum = pgEnum("tigerbeetle_account_type", [
  "merchant", "escrow", "platform_fee", "float", "suspense",
]);
export const tigerBeetleAccounts = pgTable("tigerbeetle_accounts", {
  id:             uuid("id").primaryKey().defaultRandom(),
  tbAccountId:    varchar("tb_account_id", { length: 64 }).notNull().unique(),
  tenantId:       varchar("tenant_id", { length: 36 }),
  accountType:    tigerBeetleAccountTypeEnum("account_type").notNull(),
  currency:       varchar("currency", { length: 8 }).notNull().default("NGN"),
  ledgerId:       integer("ledger_id").notNull().default(700),
  code:           integer("code").notNull().default(1000),
  flags:          integer("flags").notNull().default(0),
  debitsPending:  bigint("debits_pending", { mode: "number" }).notNull().default(0),
  debitsPosted:   bigint("debits_posted", { mode: "number" }).notNull().default(0),
  creditsPending: bigint("credits_pending", { mode: "number" }).notNull().default(0),
  creditsPosted:  bigint("credits_posted", { mode: "number" }).notNull().default(0),
  lastSyncedAt:   timestamp("last_synced_at"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("tb_accounts_tenant_idx").on(t.tenantId),
  index("tb_accounts_type_idx").on(t.accountType),
  uniqueIndex("tb_accounts_tb_id_idx").on(t.tbAccountId),
]);
export type TigerBeetleAccount = typeof tigerBeetleAccounts.$inferSelect;

// ── APISIX Route Configs ──────────────────────────────────────────────────────
export const apisixRouteStatusEnum = pgEnum("apisix_route_status", [
  "active", "inactive", "draft",
]);
export const apisixRouteConfigs = pgTable("apisix_route_configs", {
  id:           uuid("id").primaryKey().defaultRandom(),
  routeId:      varchar("route_id", { length: 64 }).notNull().unique(),
  tenantId:     varchar("tenant_id", { length: 36 }),
  name:         varchar("name", { length: 255 }).notNull(),
  uri:          varchar("uri", { length: 512 }).notNull(),
  methods:      jsonb("methods").notNull().$type<string[]>(),
  upstreamUrl:  varchar("upstream_url", { length: 512 }).notNull(),
  plugins:      jsonb("plugins"),
  status:       apisixRouteStatusEnum("status").notNull().default("active"),
  rateLimitRpm: integer("rate_limit_rpm").default(1000),
  apisixSynced: boolean("apisix_synced").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("apisix_routes_tenant_idx").on(t.tenantId),
  index("apisix_routes_status_idx").on(t.status),
  uniqueIndex("apisix_routes_route_id_idx").on(t.routeId),
]);
export type ApisixRouteConfig = typeof apisixRouteConfigs.$inferSelect;

// ── Dapr Event Audit Log ──────────────────────────────────────────────────────
export const daprEventStatusEnum = pgEnum("dapr_event_status", [
  "published", "failed", "retrying",
]);
export const daprEventLog = pgTable("dapr_event_log", {
  id:          uuid("id").primaryKey().defaultRandom(),
  pubsubName:  varchar("pubsub_name", { length: 128 }).notNull(),
  topic:       varchar("topic", { length: 256 }).notNull(),
  tenantId:    varchar("tenant_id", { length: 36 }),
  entityId:    varchar("entity_id", { length: 128 }),
  eventType:   varchar("event_type", { length: 128 }),
  payload:     jsonb("payload").notNull(),
  status:      daprEventStatusEnum("status").notNull().default("published"),
  errorMsg:    text("error_msg"),
  retryCount:  integer("retry_count").notNull().default(0),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
}, (t) => [
  index("dapr_log_topic_idx").on(t.topic),
  index("dapr_log_tenant_idx").on(t.tenantId),
  index("dapr_log_status_idx").on(t.status),
  index("dapr_log_published_idx").on(t.publishedAt),
]);
export type DaprEventLog = typeof daprEventLog.$inferSelect;

// ── OpenAppSec WAF Events ─────────────────────────────────────────────────────
export const openappsecSeverityEnum = pgEnum("openappsec_severity", [
  "critical", "high", "medium", "low", "info",
]);
export const openappsecWafEvents = pgTable("openappsec_waf_events", {
  id:         uuid("id").primaryKey().defaultRandom(),
  tenantId:   varchar("tenant_id", { length: 36 }),
  severity:   openappsecSeverityEnum("severity").notNull().default("medium"),
  attackType: varchar("attack_type", { length: 128 }),
  sourceIp:   varchar("source_ip", { length: 45 }),
  requestUri: text("request_uri"),
  method:     varchar("method", { length: 10 }),
  userAgent:  text("user_agent"),
  blocked:    boolean("blocked").notNull().default(true),
  rawEvent:   jsonb("raw_event"),
  detectedAt: timestamp("detected_at").notNull().defaultNow(),
}, (t) => [
  index("waf_events_tenant_idx").on(t.tenantId),
  index("waf_events_severity_idx").on(t.severity),
  index("waf_events_detected_idx").on(t.detectedAt),
  index("waf_events_ip_idx").on(t.sourceIp),
]);
export type OpenappsecWafEvent = typeof openappsecWafEvents.$inferSelect;

// ── Lakehouse Pipeline Runs ───────────────────────────────────────────────────
export const lakehouseRunStatusEnum = pgEnum("lakehouse_run_status", [
  "running", "completed", "failed", "partial",
]);
export const lakehousePipelineRuns = pgTable("lakehouse_pipeline_runs", {
  id:               uuid("id").primaryKey().defaultRandom(),
  pipelineType:     varchar("pipeline_type", { length: 64 }).notNull(),
  stage:            varchar("stage", { length: 64 }).notNull(),
  status:           lakehouseRunStatusEnum("status").notNull().default("running"),
  recordsExtracted: integer("records_extracted").default(0),
  recordsLoaded:    integer("records_loaded").default(0),
  featuresWritten:  integer("features_written").default(0),
  modelVersion:     varchar("model_version", { length: 64 }),
  durationMs:       integer("duration_ms"),
  errorMsg:         text("error_msg"),
  metadata:         jsonb("metadata"),
  startedAt:        timestamp("started_at").notNull().defaultNow(),
  completedAt:      timestamp("completed_at"),
}, (t) => [
  index("lakehouse_runs_type_idx").on(t.pipelineType),
  index("lakehouse_runs_status_idx").on(t.status),
  index("lakehouse_runs_started_idx").on(t.startedAt),
]);
export type LakehousePipelineRun = typeof lakehousePipelineRuns.$inferSelect;

// ── Compliance: Erasure Requests (NDPR/GDPR data-subject rights) ────────────
export const erasureRequestStatusEnum = pgEnum("erasure_request_status", [
  "pending", "completed", "rejected",
]);
export const erasureRequests = pgTable("erasure_requests", {
  id:          uuid("id").primaryKey().defaultRandom(),
  userId:      integer("user_id").notNull().references(() => users.id),
  status:      erasureRequestStatusEnum("status").notNull().default("pending"),
  reason:      text("reason"),
  // Set when the request is blocked (e.g. open escrows / pending withdrawals).
  blockedReason: text("blocked_reason"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  processedBy: integer("processed_by"),
}, (t) => [
  index("erasure_requests_user_idx").on(t.userId),
  index("erasure_requests_status_idx").on(t.status),
]);
export type ErasureRequest = typeof erasureRequests.$inferSelect;
export type NewErasureRequest = typeof erasureRequests.$inferInsert;

// ── Compliance: Fraud Cases (AML/SAR-style filing queue, NFIU-adapted) ──────
export const fraudCaseStatusEnum = pgEnum("fraud_case_status", [
  "pending",     // queued for filing
  "filed",       // successfully filed via notification/webhook path
  "failed",      // last filing attempt failed (retryable)
  "dead_letter", // exhausted max attempts — DLQ
]);
export const fraudCases = pgTable("fraud_cases", {
  id:              uuid("id").primaryKey().defaultRandom(),
  tenantId:        varchar("tenant_id", { length: 36 }).notNull(),
  paymentIntentId: varchar("payment_intent_id", { length: 64 }),
  orderId:         varchar("order_id", { length: 36 }),
  customerId:      varchar("customer_id", { length: 64 }),
  fraudScore:      numeric("fraud_score", { precision: 5, scale: 4 }).notNull(),
  riskLevel:       varchar("risk_level", { length: 16 }).notNull(),
  status:          fraudCaseStatusEnum("status").notNull().default("pending"),
  attempts:        integer("attempts").notNull().default(0),
  lastError:       text("last_error"),
  lastAttemptAt:   timestamp("last_attempt_at"),
  filedAt:         timestamp("filed_at"),
  payload:         jsonb("payload"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("fraud_cases_tenant_idx").on(t.tenantId),
  index("fraud_cases_status_idx").on(t.status),
  index("fraud_cases_payment_intent_idx").on(t.paymentIntentId),
]);
export type FraudCase = typeof fraudCases.$inferSelect;
export type NewFraudCase = typeof fraudCases.$inferInsert;

// ── Compliance: Audit Logs (money-movement + admin forensic trail) ──────────
export const auditLogs = pgTable("audit_logs", {
  id:         uuid("id").primaryKey().defaultRandom(),
  actorId:    varchar("actor_id", { length: 64 }),
  actorRole:  varchar("actor_role", { length: 32 }),
  action:     varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entity_type", { length: 64 }).notNull(),
  entityId:   varchar("entity_id", { length: 128 }),
  tenantId:   varchar("tenant_id", { length: 36 }),
  summary:    text("summary"),
  before:     jsonb("before"),
  after:      jsonb("after"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("audit_logs_actor_idx").on(t.actorId),
  index("audit_logs_action_idx").on(t.action),
  index("audit_logs_entity_idx").on(t.entityType, t.entityId),
  index("audit_logs_created_idx").on(t.createdAt),
]);
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

// ── Compliance: Messaging Consents (NDPR opt-in/opt-out per channel) ────────
// One row per (tenant, phone, channel): whether the person has granted consent
// to receive proactive messages (order updates, broadcasts) on that channel.
// Written by the conversational consent prompt (server/services/consent.ts);
// read by broadcast/notification paths via hasConsent(tenantId, phone).
export const consents = pgTable("consents", {
  id:         uuid("id").primaryKey().defaultRandom(),
  tenantId:   varchar("tenant_id", { length: 36 }).notNull(),
  phone:      varchar("phone", { length: 30 }).notNull(),
  customerId: varchar("customer_id", { length: 36 }),
  channel:    varchar("channel", { length: 30 }).notNull().default("whatsapp"),
  granted:    boolean("granted").notNull().default(false),
  // W17 F8: GDPR/NDPR-grade consent tooling (additive columns).
  scope:      varchar("scope", { length: 40 }).notNull().default("marketing"),
  source:     varchar("source", { length: 60 }),
  grantedAt:  timestamp("granted_at"),
  withdrawnAt: timestamp("withdrawn_at"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("consents_tenant_phone_channel_idx").on(t.tenantId, t.phone, t.channel),
  index("consents_tenant_channel_granted_idx").on(t.tenantId, t.channel, t.granted),
]);
export type Consent = typeof consents.$inferSelect;
export type NewConsent = typeof consents.$inferInsert;
// ── Integrations: transactional outbox for Medusa / Twenty CRM / Odoo sync ──
// Every local mutation that must reach an external system is first recorded
// here (direction='out', status='pending') and delivered asynchronously by the
// outbox dispatcher (server/services/integrations/outbox.ts) — never
// fire-and-forget. Inbound webhook payloads are recorded with direction='in'.
export const integrationEvents = pgTable("integration_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  system: text("system").notNull(), // 'medusa' | 'twenty' | 'odoo'
  direction: text("direction").notNull(), // 'out' | 'in'
  entity: text("entity").notNull(), // 'order' | 'customer' | 'product' | ...
  entityId: text("entityId"),
  payload: jsonb("payload"), // { action, origin: 'platform'|'external', data: {...} }
  status: text("status").default("pending").notNull(), // 'pending' | 'delivered' | 'failed' | 'dead'
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
}, (t) => [
  index("integration_events_status_attempts_idx").on(t.status, t.attempts),
  index("integration_events_tenant_idx").on(t.tenantId),
]);
export type IntegrationEvent = typeof integrationEvents.$inferSelect;
export type NewIntegrationEvent = typeof integrationEvents.$inferInsert;

// ── Platform ops: webhook idempotency ledger ────────────────────────────────
// Insert-first claim at the WhatsApp webhook entry: the Meta wamid/event id is
// the primary key, so concurrent/retry deliveries collide on the PK and are
// skipped (ON CONFLICT DO NOTHING). Rows are swept after 7 days by the
// /api/cron/webhook-dedupe-sweep cron. NOTE: id is varchar(64), not the usual
// 36 — Meta wamids ("wamid.HBg…") routinely exceed 36 chars.
export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: varchar("id", { length: 64 }).primaryKey(),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  type: varchar("type", { length: 64 }).notNull(),
  processedAt: timestamp("processedAt").defaultNow().notNull(),
}, (t) => [
  index("processed_webhook_events_processed_at_idx").on(t.processedAt),
  index("processed_webhook_events_tenant_idx").on(t.tenantId),
]);
export type ProcessedWebhookEvent = typeof processedWebhookEvents.$inferSelect;
export type NewProcessedWebhookEvent = typeof processedWebhookEvents.$inferInsert;

// ── Platform ops: usage metering counters ────────────────────────────────────
// Monthly per-tenant usage counters (period = "yyyymm"). Upsert-incremented by
// services/metering.ts; plan limits live in tenants.settings.plan.
export const usageCounters = pgTable("usage_counters", {
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  metric: varchar("metric", { length: 64 }).notNull(),
  period: varchar("period", { length: 6 }).notNull(),
  count: integer("count").default(0).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.metric, t.period] }),
]);
export type UsageCounter = typeof usageCounters.$inferSelect;
export type NewUsageCounter = typeof usageCounters.$inferInsert;

// ── Wave 8: Trade credit engine (B2B procurement on credit) ─────────────────
// A credit_account is the (supplier tenant, buyer tenant) credit facility:
// the supplier extends a limit with terms_days net payment terms; draws
// (invoice_draw ledger rows) raise outstanding_cents, repayments lower it.
// MONEY-PATH INVARIANT: outstanding_cents only ever moves via claim-first
// conditional UPDATEs in server/services/tradeCredit (never read-then-write),
// so concurrent draws can never exceed limit_cents and repayments can never
// push outstanding below zero.
export const creditAccounts = pgTable("credit_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierTenantId: varchar("supplier_tenant_id", { length: 36 }).notNull(),
  buyerTenantId: varchar("buyer_tenant_id", { length: 36 }).notNull(),
  limitCents: bigint("limit_cents", { mode: "number" }).notNull().default(0),
  outstandingCents: bigint("outstanding_cents", { mode: "number" }).notNull().default(0),
  termsDays: integer("terms_days").notNull().default(30),
  status: varchar("status", { length: 20 }).notNull().default("active"), // 'pending' | 'active' | 'frozen' | 'closed'
  score: integer("score"),
  scoreReasons: jsonb("score_reasons"), // string[] human-readable scoring rationale
  // W13: repayment-at-source mandate linked to this facility (payment_mandates.id).
  mandateId: varchar("mandate_id", { length: 36 }),
  // W13: order-access suspension (credit control plane). suspended=true blocks
  // new credit-backed orders for this (buyer, supplier) pair while leaving the
  // ledger intact; lifted automatically when outstanding returns to 0.
  suspended: boolean("suspended").notNull().default(false),
  suspendedAt: timestamp("suspended_at"),
  suspensionReason: varchar("suspension_reason", { length: 255 }),
  // W14: credit-bureau consent capture (roadmap F3). bureauConsentAt is the
  // buyer's acceptance timestamp of the bureau-reporting terms; accounts
  // without it are EXCLUDED from bureau reporting (compliance/bureau.ts).
  bureauConsentAt: timestamp("bureau_consent_at"),
  bureauConsentRef: varchar("bureau_consent_ref", { length: 64 }),
  // W14: link to the wholesale credit_facilities row funding this facility.
  facilityId: varchar("facility_id", { length: 36 }),
  // W18: risk-based terms (tradeCredit/terms.ts) — facility fee in basis
  // points snapshotted at approval. NULL for facilities approved before W18
  // (downward-compatible: no fee).
  feeBps: integer("fee_bps"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("credit_accounts_pair_uniq").on(t.supplierTenantId, t.buyerTenantId),
  index("credit_accounts_buyer_idx").on(t.buyerTenantId),
]);
export type CreditAccount = typeof creditAccounts.$inferSelect;
export type NewCreditAccount = typeof creditAccounts.$inferInsert;

// ── W13: repayment-at-source mandates + credit limit history ───────────────
// payment_mandates: a buyer-tenant authorization letting the platform debit
// them at source (direct-debit / tokenized bank auth) for credit repayments.
// Status machine: pending → active (authorization confirmed) → revoked |
// failed. Provider interactions live in server/services/payments/mandates.ts;
// the mandate-capable provider contract is implemented by the payments wave
// (createMandate/chargeMandate/revokeMandate on PaymentProvider).
export const paymentMandates = pgTable("payment_mandates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenantId", { length: 36 }).notNull().references(() => tenants.id),
  provider: varchar("provider", { length: 30 }).notNull(),
  mandateRef: varchar("mandateRef", { length: 128 }).notNull(),
  customerRef: varchar("customerRef", { length: 128 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // 'pending' | 'active' | 'revoked' | 'failed'
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("payment_mandates_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("payment_mandates_tenant_provider_ref_uniq").on(t.tenantId, t.provider, t.mandateRef),
]);
export type PaymentMandate = typeof paymentMandates.$inferSelect;
export type NewPaymentMandate = typeof paymentMandates.$inferInsert;

// mandate_charges (A1-02/F-03): durable record of every repayment-at-source
// mandate charge. Previously mandate charges were persisted nowhere, so a
// 'pending' provider charge was settled immediately (money had NOT moved)
// and could never be reconciled. The sweeper
// (tradeCredit/capture.reconcilePendingMandateCharges) re-checks pending
// rows via the provider's fetchStatus() and settles exactly once on
// success / releases the dedupe claim on failure. `reference` is the
// exactly-once repayment reference (cr-…), shared with the
// processed_webhook_events claim and the credit_ledger repayment ref.
export const mandateCharges = pgTable("mandate_charges", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => creditAccounts.id),
  mandateId: uuid("mandate_id"),
  mandateRef: varchar("mandate_ref", { length: 128 }),
  provider: varchar("provider", { length: 30 }).notNull(),
  reference: varchar("reference", { length: 128 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // 'pending' | 'success' | 'failed'
  providerStatus: varchar("provider_status", { length: 40 }),
  rawResponse: jsonb("raw_response"), // redacted per compliance/bureau conventions
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("mandate_charges_reference_uniq").on(t.reference),
  index("mandate_charges_account_idx").on(t.accountId),
  index("mandate_charges_status_idx").on(t.status),
]);
export type MandateCharge = typeof mandateCharges.$inferSelect;
export type NewMandateCharge = typeof mandateCharges.$inferInsert;

// credit_limit_history: append-only audit of limit revisions (auto or
// manual). reason 'auto_revision' for scorer-driven changes, 'limit_clamped'
// when a downward revision was clamped at the outstanding balance.
export const creditLimitHistory = pgTable("credit_limit_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("accountId").notNull().references(() => creditAccounts.id),
  oldLimitCents: bigint("oldLimitCents", { mode: "number" }).notNull(),
  newLimitCents: bigint("newLimitCents", { mode: "number" }).notNull(),
  score: integer("score"),
  reason: varchar("reason", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => [
  index("credit_limit_history_account_idx").on(t.accountId),
]);
export type CreditLimitHistoryEntry = typeof creditLimitHistory.$inferSelect;
export type NewCreditLimitHistoryEntry = typeof creditLimitHistory.$inferInsert;

// ── W14: credit-bureau reporting + wholesale facilities (roadmap F3) ───────
// bureau_report_log: one row per attempted bureau report. Status machine:
// pending (never sent / send failed — retryable via retryFailedReports) →
// sent | disputed (buyer disputes the reported datum). payload is the
// REDACTED event body (secrets stripped before persist — compliance/bureau.ts).
export const bureauReportLog = pgTable("bureau_report_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: varchar("account_id", { length: 36 }).notNull(),
  eventType: varchar("event_type", { length: 30 }).notNull(), // 'disbursement' | 'repayment' | 'delinquency' | 'cure' | 'closure'
  bureau: varchar("bureau", { length: 20 }).notNull(), // 'crc' | 'creditregistry' | 'customHttp' | 'disabled'
  status: varchar("status", { length: 20 }).notNull().default("pending"), // 'pending' | 'sent' | 'failed' | 'disputed'
  payload: jsonb("payload"),
  response: jsonb("response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("bureau_report_log_account_idx").on(t.accountId),
  index("bureau_report_log_status_idx").on(t.status),
]);
export type BureauReportLogEntry = typeof bureauReportLog.$inferSelect;
export type NewBureauReportLogEntry = typeof bureauReportLog.$inferInsert;

// credit_facilities: lender-side wholesale facilities that fund the
// trade-credit book. commitment_cents is the lender's total commitment;
// advance_rate_bps (default 8000 = 80%) caps the eligible collateral advance.
// CONTRACT for W14-C2: keep column names/types exactly as written.
export const creditFacilities = pgTable("credit_facilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  lenderName: varchar("lender_name", { length: 255 }).notNull(),
  facilityRef: varchar("facility_ref", { length: 64 }).notNull(),
  commitmentCents: bigint("commitment_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  advanceRateBps: integer("advance_rate_bps").notNull().default(8000),
  covenants: jsonb("covenants"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("credit_facilities_ref_uniq").on(t.facilityRef),
]);
export type CreditFacility = typeof creditFacilities.$inferSelect;
export type NewCreditFacility = typeof creditFacilities.$inferInsert;

// Append-only credit ledger. amount_cents is always non-negative; direction
// is encoded by kind: 'invoice_draw' + 'fee' raise exposure, 'repayment'
// lowers it, 'adjustment' is a zero-amount note (e.g. limit-increase
// requests). Dunning state is tracked via [dun:...] markers in `note` —
// see server/services/tradeCredit/dunning.ts.
export const creditLedger = pgTable("credit_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditAccountId: uuid("credit_account_id").notNull().references(() => creditAccounts.id),
  kind: varchar("kind", { length: 20 }).notNull(), // 'invoice_draw' | 'repayment' | 'fee' | 'adjustment'
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  poId: varchar("po_id", { length: 36 }),
  dueDate: timestamp("due_date"),
  status: varchar("status", { length: 20 }).notNull().default("posted"), // 'posted' | 'settled' | 'void'
  ref: varchar("ref", { length: 128 }),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("credit_ledger_account_idx").on(t.creditAccountId),
  index("credit_ledger_due_idx").on(t.dueDate),
  // W14.1: exactly-once repayment per (account, ref). Scoped to repayment
  // rows only — settlement_retry markers share the table with kind
  // 'adjustment' and the SAME ref, so a full-table index would collide.
  // Two concurrent retrySettlement calls now resolve to one insert; the
  // loser sees 23505 and applyRepaymentTx translates it to an idempotent
  // already_settled-style no-op.
  uniqueIndex("credit_ledger_repayment_ref_uniq")
    .on(t.creditAccountId, t.ref)
    .where(sql`kind = 'repayment' AND ref IS NOT NULL`),
  // A1-04/F-01: exactly-once invoice draw per (account, ref). Draw refs are
  // `draw:{poId}` — without this index two concurrent PO approvals (or a
  // crash-retry) could insert two draw rows and increment outstanding twice
  // for one PO. The loser sees 23505, which drawOnCreditTx translates into
  // an idempotent already-drawn success returning the existing row.
  uniqueIndex("credit_ledger_draw_ref_uniq")
    .on(t.creditAccountId, t.ref)
    .where(sql`kind = 'invoice_draw' AND ref IS NOT NULL`),
]);
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;
// ── Wave 8: B2B procurement — supplier profiles + purchase orders ───────────
// supplier_profiles: one row per supplier TENANT (pk = tenants.id semantics).
// Drives the procurement directory (MOQ, lead time, offered credit terms,
// auto-approve threshold) and the WhatsApp buyer/supplier PO flows.
// NOTE: cents columns are bigint minor units (kobo); S3 reads these tables
// via raw SQL — keep the column names/types EXACTLY as written.
export const supplierProfiles = pgTable("supplier_profiles", {
  tenantId:             varchar("tenant_id", { length: 36 }).primaryKey(),
  moqCents:             bigint("moq_cents", { mode: "number" }).notNull().default(0),
  leadTimeDays:         integer("lead_time_days").notNull().default(3),
  /** e.g. [7, 14, 30] — net terms (days) the supplier offers on credit POs. */
  termsOffered:         jsonb("terms_offered").$type<number[]>(),
  defaultTermsDays:     integer("default_terms_days").notNull().default(14),
  autoApproveBelowCents: bigint("auto_approve_below_cents", { mode: "number" }),
  /** Product category labels the supplier sells (directory filter). */
  categories:           jsonb("categories").$type<string[]>(),
  status:               varchar("status", { length: 20 }).notNull().default("active"),
  createdAt:            timestamp("created_at").notNull().defaultNow(),
  updatedAt:            timestamp("updated_at").notNull().defaultNow(),
});
export type SupplierProfile = typeof supplierProfiles.$inferSelect;
export type NewSupplierProfile = typeof supplierProfiles.$inferInsert;

// purchase_orders: B2B restock orders from a buyer tenant to a supplier tenant.
// Status machine: draft → submitted → approved|rejected → fulfilled → invoiced
// → paid (credit path jumps approved → invoiced on successful drawOnCredit).
export const purchaseOrders = pgTable("purchase_orders", {
  id:               uuid("id").primaryKey().defaultRandom(),
  poNumber:         varchar("po_number", { length: 32 }).notNull().unique(),
  buyerTenantId:    varchar("buyer_tenant_id", { length: 36 }).notNull(),
  supplierTenantId: varchar("supplier_tenant_id", { length: 36 }).notNull(),
  status:           varchar("status", { length: 20 }).notNull().default("draft"),
  subtotalCents:    bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
  paymentMode:      varchar("payment_mode", { length: 20 }).notNull().default("credit"),
  creditAccountId:  uuid("credit_account_id"),
  /** Agreed net terms (days) at submit/approve time — null for paynow POs. */
  termsDays:        integer("terms_days"),
  dueDate:          timestamp("due_date"),
  /**
   * WhatsApp phone of the buyer-side contact who placed the PO (E.164) —
   * approval/rejection/payment notifications route here. Nullable so router-
   * created POs without a chat contact remain valid.
   */
  buyerPhone:       varchar("buyer_phone", { length: 30 }),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("purchase_orders_buyer_status_idx").on(t.buyerTenantId, t.status),
  index("purchase_orders_supplier_status_idx").on(t.supplierTenantId, t.status),
]);
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;

export const poItems = pgTable("po_items", {
  id:             uuid("id").primaryKey().defaultRandom(),
  poId:           uuid("po_id").notNull().references(() => purchaseOrders.id),
  productRef:     varchar("product_ref", { length: 128 }),
  name:           varchar("name", { length: 255 }).notNull(),
  qty:            integer("qty").notNull(),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
  lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
}, (t) => [
  index("po_items_po_idx").on(t.poId),
]);
export type PoItem = typeof poItems.$inferSelect;
export type NewPoItem = typeof poItems.$inferInsert;

// ─── w9: media assets (brand studio generated logos / kits) ─────────────────
export const mediaAssets = pgTable("media_assets", {
  id:       uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  /** Asset kind, e.g. "logo", "brand_kit", "wa_profile_photo". */
  kind:     varchar("kind", { length: 32 }).notNull(),
  mime:     varchar("mime", { length: 64 }).notNull(),
  /** data:<mime>;base64,<payload> — self-contained, no external storage needed. */
  dataUri:  text("data_uri").notNull(),
  meta:     jsonb("meta"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("media_assets_tenant_idx").on(t.tenantId),
]);
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
// ── Wave 9: Agentic onboarding copilot sessions ─────────────────────────────
// One row per onboarding-copilot conversation (admin dashboard or WhatsApp
// channel). `state` machine: intake → proposing → approving → configuring →
// validating → live (↘ failed / abandoned). `proposals` is the approval-
// checkpoint ledger: the copilot may create proposals freely, but
// applyProposal/pushProfile/goLive refuse until a human flips status to
// 'approved' (or 'edited' with a caller-supplied payload).
export const onboardingSessions = pgTable("onboarding_sessions", {
  id:          uuid("id").primaryKey().defaultRandom(),
  /** Null until the copilot provisions the tenant mid-flow. */
  tenantId:    varchar("tenant_id", { length: 36 }),
  channel:     varchar("channel", { length: 16 }).notNull(), // 'admin' | 'whatsapp'
  /** WhatsApp phone (E.164) for channel='whatsapp' resume lookups. */
  phone:       varchar("phone", { length: 30 }),
  state:       varchar("state", { length: 20 }).notNull().default("intake"),
  /** [{ role: 'user'|'agent'|'system', text, ts }] */
  transcript:  jsonb("transcript").notNull().default([]),
  /** [{ id, kind, summary, payload, status }] — see server/services/onboardingCopilot */
  proposals:   jsonb("proposals").notNull().default([]),
  /** Extracted business facts + repair-loop metadata. */
  intake:      jsonb("intake"),
  error:       text("error"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("onboarding_sessions_tenant_idx").on(t.tenantId),
  index("onboarding_sessions_channel_phone_idx").on(t.channel, t.phone),
  index("onboarding_sessions_state_idx").on(t.state),
]);
export type OnboardingSessionRow = typeof onboardingSessions.$inferSelect;
export type NewOnboardingSessionRow = typeof onboardingSessions.$inferInsert;

// ── W17 F11: CRM lead scoring (commerce-native, Twenty stays system of record)
// customer_lead_scores: one row per (tenantId, customerId), recomputed by
// server/services/leadScoring.refreshLeadScores. `factors` is the explainable
// breakdown — every score delta the pure computeLeadScore function applied.
export const customerLeadScores = pgTable("customer_lead_scores", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar("tenantId", { length: 36 }).notNull(),
  customerId: varchar("customerId", { length: 36 }).notNull().references(() => customers.id),
  score: integer("score").notNull().default(0),
  band: varchar("band", { length: 10 }).notNull().default("cold"), // 'hot' | 'warm' | 'cold'
  stage: varchar("stage", { length: 20 }).notNull().default("new_lead"), // derived pipeline stage
  factors: jsonb("factors").notNull().default([]), // [{factor, delta}]
  computedAt: timestamp("computed_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("customer_lead_scores_tenant_idx").on(t.tenantId),
  uniqueIndex("customer_lead_scores_tenant_customer_uniq").on(t.tenantId, t.customerId),
]);
export type CustomerLeadScore = typeof customerLeadScores.$inferSelect;
export type NewCustomerLeadScore = typeof customerLeadScores.$inferInsert;

// ── W19 SOC2: tamper-evident audit chain ────────────────────────────────────
// Append-only hash-chained audit log. Each row's `hash` =
// sha256(prevHash + canonical(event fields)) — see server/services/auditChain.ts.
// `prev_hash` links to the previous row's hash (GENESIS_HASH for the first
// row), so any edit/delete/reorder breaks verification. tenant_id is nullable
// for platform-level events.
export const auditChain = pgTable("audit_chain", {
  id:        uuid("id").primaryKey().defaultRandom(),
  tenantId:  varchar("tenant_id", { length: 36 }),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  actorId:   varchar("actor_id", { length: 64 }),
  payload:   jsonb("payload_jsonb"),
  prevHash:  varchar("prev_hash", { length: 64 }).notNull(),
  hash:      varchar("hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("audit_chain_tenant_idx").on(t.tenantId),
  index("audit_chain_created_idx").on(t.createdAt),
  index("audit_chain_event_type_idx").on(t.eventType),
]);
export type AuditChainRow = typeof auditChain.$inferSelect;
export type NewAuditChainRow = typeof auditChain.$inferInsert;

// ── W19 SOC2: data retention policies ───────────────────────────────────────
// One row per (tenant, entity): how many days rows of that entity are kept
// before purge. legal_hold=true exempts the entity from purge (litigation /
// regulator hold). Consumed by server/services/retention.ts.
export const retentionPolicies = pgTable("retention_policies", {
  id:            uuid("id").primaryKey().defaultRandom(),
  tenantId:      varchar("tenant_id", { length: 36 }).notNull(),
  entity:        varchar("entity", { length: 64 }).notNull(),
  retentionDays: integer("retention_days").notNull(),
  legalHold:     boolean("legal_hold").notNull().default(false),
  updatedAt:     timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("retention_policies_tenant_entity_uniq").on(t.tenantId, t.entity),
  index("retention_policies_tenant_idx").on(t.tenantId),
]);
export type RetentionPolicy = typeof retentionPolicies.$inferSelect;
export type NewRetentionPolicy = typeof retentionPolicies.$inferInsert;

// ── W19 SOC2: incident log ──────────────────────────────────────────────────
// Security/availability incident register. Status machine:
// open → investigating → mitigated → resolved (resolved_at set on resolve).
export const incidents = pgTable("incidents", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  severity:    varchar("severity", { length: 20 }).notNull().default("low"), // 'low' | 'medium' | 'high' | 'critical'
  status:      varchar("status", { length: 20 }).notNull().default("open"), // 'open' | 'investigating' | 'mitigated' | 'resolved'
  title:       varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  openedAt:    timestamp("opened_at").notNull().defaultNow(),
  resolvedAt:  timestamp("resolved_at"),
}, (t) => [
  index("incidents_tenant_idx").on(t.tenantId),
  index("incidents_tenant_status_idx").on(t.tenantId, t.status),
]);
export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;

// ── W20: ML propensity lead-scoring model registry ─────────────────────────
// One row per trained per-tenant logistic-regression model
// (server/services/mlLeadScoring.ts). weights_jsonb is a number[] aligned
// with feature_names (a string[]); version increments per tenant per train.
// Training rows are gated by MIN_TRAIN_SAMPLES — tenants below the gate have
// NO rows here and scoring falls back to the rule-based lead score.
export const leadScoreModels = pgTable("lead_score_models", {
  id:           uuid("id").primaryKey().defaultRandom(),
  tenantId:     varchar("tenant_id", { length: 36 }).notNull(),
  weights:      jsonb("weights_jsonb").notNull(), // number[], aligned with featureNames
  featureNames: jsonb("feature_names").notNull(), // string[]
  trainedAt:    timestamp("trained_at").notNull().defaultNow(),
  sampleCount:  integer("sample_count").notNull(),
  logloss:      real("logloss"), // final training log-loss (null if not computed)
  version:      integer("version").notNull().default(1),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_score_models_tenant_idx").on(t.tenantId),
  uniqueIndex("lead_score_models_tenant_version_uniq").on(t.tenantId, t.version),
]);
export type LeadScoreModel = typeof leadScoreModels.$inferSelect;
export type NewLeadScoreModel = typeof leadScoreModels.$inferInsert;

// ── W21: ML probability-of-default (PD) credit model registry ──────────────
// One row per trained logistic-regression PD model
// (server/services/tradeCredit/mlPdScoring.ts). tenant_id is NULLABLE: a
// null-tenant row is the GLOBAL corpus model used as fallback when a
// tenant's own book is below the minimum-sample gate. weights_jsonb is a
// number[] aligned with feature_names (a string[]); version increments per
// scope per train. Tenants/scopes below the gate have NO rows here and PD
// scoring falls back to the rule-score proxy (pd = 1 − score/100).
export const creditPdModels = pgTable("credit_pd_models", {
  id:           uuid("id").primaryKey().defaultRandom(),
  tenantId:     varchar("tenant_id", { length: 36 }), // NULL = global corpus model
  weights:      jsonb("weights_jsonb").notNull(), // number[], aligned with featureNames
  featureNames: jsonb("feature_names").notNull(), // string[]
  trainedAt:    timestamp("trained_at").notNull().defaultNow(),
  sampleCount:  integer("sample_count").notNull(),
  logloss:      real("logloss"), // final training log-loss (null if not computed)
  auc:          real("auc"), // rank AUC on the training set (null when single-class)
  version:      integer("version").notNull().default(1),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("credit_pd_models_tenant_idx").on(t.tenantId),
  uniqueIndex("credit_pd_models_tenant_version_uniq").on(t.tenantId, t.version),
]);
export type CreditPdModel = typeof creditPdModels.$inferSelect;
export type NewCreditPdModel = typeof creditPdModels.$inferInsert;

// ── W21: uplift-modeled broadcast targeting model registry ──────────────────
// Per-tenant, per-role ('treatment' | 'control') logistic-regression weights
// learned by server/services/mlUplift.ts: treatment arm from customers who
// received a prior broadcast/win-back message, control arm from comparable
// non-messaged customers. scoreUplift = pTreatment − pControl. Tenants below
// the per-arm minimum-sample gate have no rows → heuristic segment fallback.
export const upliftModels = pgTable("uplift_models", {
  id:           uuid("id").primaryKey().defaultRandom(),
  tenantId:     varchar("tenant_id", { length: 36 }).notNull(),
  role:         varchar("role", { length: 16 }).notNull(), // 'treatment' | 'control'
  weights:      jsonb("weights_jsonb").notNull(), // number[], aligned with featureNames
  featureNames: jsonb("feature_names").notNull(), // string[]
  trainedAt:    timestamp("trained_at").notNull().defaultNow(),
  sampleCount:  integer("sample_count").notNull(),
  logloss:      real("logloss"), // final training log-loss (null if not computed)
  version:      integer("version").notNull().default(1),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("uplift_models_tenant_idx").on(t.tenantId),
  uniqueIndex("uplift_models_tenant_role_version_uniq").on(t.tenantId, t.role, t.version),
]);
export type UpliftModel = typeof upliftModels.$inferSelect;
export type NewUpliftModel = typeof upliftModels.$inferInsert;

// ── W22: contextual-bandit credit-limit decision log ────────────────────────
// One row per limit suggestion the LinUCB bandit scored
// (server/services/banditLimits.ts). context is the normalized feature
// vector (number[], aligned with BANDIT_FEATURE_NAMES); chosenMultiplier is
// the arm the policy picked; suggestedLimitCents is the bandit's
// (cap-clamped) limit, baselineLimitCents the rule-based baseline. mode is
// 'shadow' (default: logged, not applied) or 'active' (only with
// BANDIT_LIMITS_MODE=active AND the min-rewarded-decisions gate met; always
// clamped by manufacturer program caps). reward is NULL until the
// bandit-reward-tick cron assigns it from repayment outcomes
// (1 on-time, 0.5 late-cured, 0 default).
export const banditDecisions = pgTable("bandit_decisions", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  tenantId:            varchar("tenant_id", { length: 36 }).notNull(),
  buyerId:             varchar("buyer_id", { length: 36 }).notNull(),
  context:             jsonb("context_jsonb").notNull(), // number[], aligned with BANDIT_FEATURE_NAMES
  chosenMultiplier:    real("chosen_multiplier").notNull(),
  suggestedLimitCents: bigint("suggested_limit_cents", { mode: "number" }).notNull(),
  baselineLimitCents:  bigint("baseline_limit_cents", { mode: "number" }).notNull(),
  mode:                varchar("mode", { length: 16 }).notNull().default("shadow"), // 'shadow' | 'active'
  reward:              real("reward"), // NULL until the reward tick assigns it
  createdAt:           timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("bandit_decisions_tenant_idx").on(t.tenantId),
  index("bandit_decisions_reward_idx").on(t.reward),
]);
export type BanditDecision = typeof banditDecisions.$inferSelect;
export type NewBanditDecision = typeof banditDecisions.$inferInsert;

// ── W20: audit-stream anomaly detection alerts ──────────────────────────────
// Alerts emitted by server/services/auditAnomaly.ts when a tenant's audit
// stream deviates from its learned baseline. Idempotent per
// (tenant_id, signal, window_bucket): re-scans of the same bucket upsert-nothing.
export const anomalyAlerts = pgTable("anomaly_alerts", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  signal:      varchar("signal", { length: 100 }).notNull(),
  score:       doublePrecision("score").notNull(),
  detail:      jsonb("detail_jsonb"),
  status:      varchar("status", { length: 20 }).notNull().default("open"), // 'open' | 'acknowledged' | 'dismissed'
  windowBucket: timestamp("window_bucket").notNull(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("anomaly_alerts_tenant_signal_bucket_uniq").on(t.tenantId, t.signal, t.windowBucket),
  index("anomaly_alerts_tenant_idx").on(t.tenantId),
  index("anomaly_alerts_tenant_status_idx").on(t.tenantId, t.status),
]);
export type AnomalyAlert = typeof anomalyAlerts.$inferSelect;
export type NewAnomalyAlert = typeof anomalyAlerts.$inferInsert;


// ── W22: graph-based collusion detection alerts ─────────────────────────────
// Alerts emitted by server/services/graphCollusion.ts when the tenant-level
// trade-interaction graph shows collusion signals (cycles, concentration,
// tight clusters). Idempotent per (tenant_id, buyer_id, signal,
// window_bucket): re-scans of the same bucket upsert-nothing.
export const graphAlerts = pgTable("graph_alerts", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  buyerId:     varchar("buyer_id", { length: 36 }).notNull(),
  signal:      varchar("signal", { length: 100 }).notNull(), // 'cycle' | 'concentration' | 'cluster'
  score:       doublePrecision("score").notNull(),
  evidence:    jsonb("evidence_jsonb"),
  status:      varchar("status", { length: 20 }).notNull().default("open"), // 'open' | 'acknowledged' | 'dismissed'
  windowBucket: timestamp("window_bucket").notNull(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("graph_alerts_tenant_buyer_signal_bucket_uniq").on(t.tenantId, t.buyerId, t.signal, t.windowBucket),
  index("graph_alerts_tenant_idx").on(t.tenantId),
  index("graph_alerts_tenant_status_idx").on(t.tenantId, t.status),
  index("graph_alerts_buyer_idx").on(t.buyerId),
]);
export type GraphAlert = typeof graphAlerts.$inferSelect;
export type NewGraphAlert = typeof graphAlerts.$inferInsert;

// ── W22: LLM copilot invocation log ─────────────────────────────────────────
// Audit trail for server/services/llmCopilot.ts (merchant Q&A + SOC2 incident
// triage). Stores ONLY the sha256 prompt hash, fallback flag and latency —
// never raw prompts, answers, or PII.
export const copilotQueries = pgTable("copilot_queries", {
  id:           uuid("id").primaryKey().defaultRandom(),
  tenantId:     varchar("tenant_id", { length: 36 }).notNull(),
  kind:         varchar("kind", { length: 10 }).notNull(), // 'triage' | 'ask'
  promptHash:   varchar("prompt_hash", { length: 64 }).notNull(), // sha256 hex
  fallbackUsed: boolean("fallback_used").notNull().default(false),
  latencyMs:    integer("latency_ms").notNull().default(0),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("copilot_queries_tenant_idx").on(t.tenantId),
  index("copilot_queries_tenant_created_idx").on(t.tenantId, t.createdAt),
]);
export type CopilotQuery = typeof copilotQueries.$inferSelect;
export type NewCopilotQuery = typeof copilotQueries.$inferInsert;

// ── W25: geospatial merchant discovery ──────────────────────────────────────
// merchant_locations: one row per merchant (tenant) branch discoverable by
// customers via geo search (WhatsApp location pin / browser geolocation).
// geohash (base32, precision 5 ≈ 5km cells) is a prefilter index; exact
// filtering is haversine in server/services/geoDiscovery.ts. Additive only.
export const merchantLocations = pgTable("merchant_locations", {
  id:              uuid("id").primaryKey().defaultRandom(),
  tenantId:        varchar("tenant_id", { length: 36 }).notNull(),
  label:           varchar("label", { length: 120 }).notNull().default("Main branch"),
  latitude:        numeric("latitude", { precision: 10, scale: 7 }).notNull(),
  longitude:       numeric("longitude", { precision: 10, scale: 7 }).notNull(),
  addressLine:     varchar("address_line", { length: 255 }),
  city:            varchar("city", { length: 120 }),
  country:         varchar("country", { length: 120 }),
  serviceRadiusKm: numeric("service_radius_km", { precision: 8, scale: 3 }).notNull().default("5"),
  deliveryZones:   jsonb("delivery_zones"),
  discoverable:    boolean("discoverable").notNull().default(false),
  openHours:       jsonb("open_hours"),
  geohash:         text("geohash").notNull(),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("merchant_locations_tenant_idx").on(t.tenantId),
  index("merchant_locations_geohash_idx").on(t.geohash),
]);
export type MerchantLocation = typeof merchantLocations.$inferSelect;
export type NewMerchantLocation = typeof merchantLocations.$inferInsert;

// ── W25: location-aware sponsored listings (paid placement) ─────────────────
// A listing boosts a tenant's ranking in discover results when the search
// point is within radiusKm of (centerLat, centerLng) and the category filter
// overlaps `categories` (empty array = all categories). ALL money is INTEGER
// CENTS. status: 'draft' | 'active' | 'paused' | 'exhausted'. Additive only.
export const sponsoredListings = pgTable("sponsored_listings", {
  id:               uuid("id").primaryKey().defaultRandom(),
  tenantId:         varchar("tenant_id", { length: 36 }).notNull(),
  name:             varchar("name", { length: 160 }).notNull(),
  categories:       jsonb("categories").notNull().default([]),
  centerLat:        numeric("center_lat", { precision: 10, scale: 7 }).notNull(),
  centerLng:        numeric("center_lng", { precision: 10, scale: 7 }).notNull(),
  radiusKm:         numeric("radius_km", { precision: 8, scale: 3 }).notNull().default("10"),
  dailyBudgetCents: integer("daily_budget_cents").notNull(),
  spentTodayCents:  integer("spent_today_cents").notNull().default(0),
  // W30: date (YYYY-MM-DD, UTC) the counter belongs to — lazy daily reset.
  spentOnDate:      varchar("spent_on_date", { length: 10 }),
  bidCents:         integer("bid_cents").notNull().default(0),
  status:           varchar("status", { length: 16 }).notNull().default("draft"),
  startsAt:         timestamp("starts_at"),
  endsAt:           timestamp("ends_at"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("sponsored_listings_tenant_idx").on(t.tenantId),
  index("sponsored_listings_status_idx").on(t.status),
]);
export type SponsoredListing = typeof sponsoredListings.$inferSelect;
export type NewSponsoredListing = typeof sponsoredListings.$inferInsert;

// === W27 catalog-ai ===
// Voice-note→listing and photo→listing AI drafts. A merchant sends a WhatsApp
// voice note or product photo; the pipeline (server/services/catalogAI.ts)
// transcribes/vision-analyses it, extracts a structured listing, suggests a
// deterministic integer-cents price, and stores a draft here pending merchant
// confirmation (WhatsApp buttons or tenant portal). ALL money is INTEGER CENTS.
// Additive only.
export const catalogAiDrafts = pgTable("catalog_ai_drafts", {
  id:               uuid("id").primaryKey().defaultRandom(),
  tenantId:         varchar("tenant_id", { length: 36 }).notNull(),
  /** 'voice' | 'photo' */
  source:           varchar("source", { length: 16 }).notNull(),
  merchantPhone:    varchar("merchant_phone", { length: 30 }).notNull(),
  /** pending_confirm | confirmed | rejected | published | expired */
  status:           varchar("status", { length: 20 }).notNull().default("pending_confirm"),
  transcript:       text("transcript"),
  mediaId:          varchar("media_id", { length: 128 }),
  name:             varchar("name", { length: 255 }),
  description:      text("description"),
  category:         varchar("category", { length: 100 }),
  suggestedPriceCents: integer("suggested_price_cents"),
  priceBandLowCents:   integer("price_band_low_cents"),
  priceBandHighCents:  integer("price_band_high_cents"),
  currency:         varchar("currency", { length: 3 }).notNull().default("NGN"),
  /** Product id once published. */
  productId:        varchar("product_id", { length: 36 }),
  rawExtraction:    jsonb("raw_extraction"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
  confirmedAt:      timestamp("confirmed_at"),
  publishedAt:      timestamp("published_at"),
}, (t) => [
  index("catalog_ai_drafts_tenant_idx").on(t.tenantId),
  index("catalog_ai_drafts_tenant_status_idx").on(t.tenantId, t.status),
  index("catalog_ai_drafts_phone_idx").on(t.merchantPhone),
]);
export type CatalogAiDraft = typeof catalogAiDrafts.$inferSelect;
export type NewCatalogAiDraft = typeof catalogAiDrafts.$inferInsert;

// W27 catalog-ai draft lifecycle audit: one row per transition
// (created/confirmed/edited/rejected/published/expired). Additive only.
export const catalogAiDraftEvents = pgTable("catalog_ai_draft_events", {
  id:        uuid("id").primaryKey().defaultRandom(),
  draftId:   uuid("draft_id").notNull(),
  tenantId:  varchar("tenant_id", { length: 36 }).notNull(),
  event:     varchar("event", { length: 24 }).notNull(),
  actor:     varchar("actor", { length: 64 }),
  detail:    jsonb("detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("catalog_ai_draft_events_draft_idx").on(t.draftId),
  index("catalog_ai_draft_events_tenant_idx").on(t.tenantId),
]);
export type CatalogAiDraftEvent = typeof catalogAiDraftEvents.$inferSelect;
export type NewCatalogAiDraftEvent = typeof catalogAiDraftEvents.$inferInsert;
// === end W27 catalog-ai ===
// === W27 bookkeeping ===
// Merchant bookkeeping: expenses (manual or receipt-photo OCR), opt-in
// WhatsApp sales digests (daily/weekly), and tax-ready export support.
// ALL money is INTEGER CENTS (kobo). Additive only — see SPEC_W27.md.

// expenses: one row per merchant expense. status flow:
//   awaiting_receipt (capture session opened via WhatsApp "expense")
//   → pending_confirm (OCR parsed, awaiting merchant confirmation)
//   → confirmed | rejected. Manual entries are created 'confirmed'.
// source: 'manual' | 'receipt_photo'.
export const expenses = pgTable("expenses", {
  id:             uuid("id").primaryKey().defaultRandom(),
  tenantId:       varchar("tenant_id", { length: 36 }).notNull(),
  amountCents:    integer("amount_cents").notNull(),
  currency:       varchar("currency", { length: 3 }).notNull().default("NGN"),
  vendor:         varchar("vendor", { length: 160 }),
  category:       varchar("category", { length: 64 }).notNull().default("general"),
  expenseDate:    timestamp("expense_date").notNull(),
  status:         varchar("status", { length: 24 }).notNull().default("awaiting_receipt"),
  source:         varchar("source", { length: 24 }).notNull().default("manual"),
  mediaId:        varchar("media_id", { length: 128 }),
  ocrText:        text("ocr_text"),
  createdByPhone: varchar("created_by_phone", { length: 32 }),
  note:           varchar("note", { length: 500 }),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("expenses_tenant_date_idx").on(t.tenantId, t.expenseDate),
  index("expenses_tenant_status_idx").on(t.tenantId, t.status),
]);
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;

// bookkeeping_digest_prefs: opt-in scheduled sales digest per (tenant, phone).
// frequency: 'daily' | 'weekly'. hour_utc: preferred send hour (UTC).
export const bookkeepingDigestPrefs = pgTable("bookkeeping_digest_prefs", {
  id:                uuid("id").primaryKey().defaultRandom(),
  tenantId:          varchar("tenant_id", { length: 36 }).notNull(),
  phone:             varchar("phone", { length: 32 }).notNull(),
  frequency:         varchar("frequency", { length: 8 }).notNull().default("weekly"),
  optedIn:           boolean("opted_in").notNull().default(true),
  hourUtc:           integer("hour_utc").notNull().default(7),
  lastSentPeriodKey: varchar("last_sent_period_key", { length: 16 }),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
  updatedAt:         timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("bookkeeping_digest_prefs_tenant_phone_idx").on(t.tenantId, t.phone),
]);
export type BookkeepingDigestPref = typeof bookkeepingDigestPrefs.$inferSelect;
export type NewBookkeepingDigestPref = typeof bookkeepingDigestPrefs.$inferInsert;

// bookkeeping_digest_log: one row per digest actually sent; the
// (tenant_id, phone, period_key) unique index makes sends idempotent.
export const bookkeepingDigestLog = pgTable("bookkeeping_digest_log", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  phone:       varchar("phone", { length: 32 }).notNull(),
  frequency:   varchar("frequency", { length: 8 }).notNull(),
  periodKey:   varchar("period_key", { length: 16 }).notNull(),
  salesCents:  integer("sales_cents").notNull().default(0),
  orderCount:  integer("order_count").notNull().default(0),
  sentAt:      timestamp("sent_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("bookkeeping_digest_log_tenant_period_idx").on(t.tenantId, t.phone, t.periodKey),
]);
export type BookkeepingDigestLogEntry = typeof bookkeepingDigestLog.$inferSelect;
export type NewBookkeepingDigestLogEntry = typeof bookkeepingDigestLog.$inferInsert;
// === W27 storefront-i18n ===
// storefronts: one public web storefront per tenant, served at /shop/:slug.
// The slug is globally unique (auto-generated default from the tenant name,
// merchant-customizable). isVisible gates public access; showLocation gates
// whether the tenant's geo location is published on the storefront (public
// rendering additionally requires an approved KYB application — see
// server/services/storefront.ts). Additive only.
export const storefronts = pgTable("storefronts", {
  id:            uuid("id").primaryKey().defaultRandom(),
  tenantId:      varchar("tenant_id", { length: 36 }).notNull(),
  slug:          varchar("slug", { length: 80 }).notNull(),
  heroText:      varchar("hero_text", { length: 280 }),
  themeColor:    varchar("theme_color", { length: 16 }).notNull().default("#075E54"),
  isVisible:     boolean("is_visible").notNull().default(false),
  showLocation:  boolean("show_location").notNull().default(false),
  defaultLocale: varchar("default_locale", { length: 8 }).notNull().default("en"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
  updatedAt:     timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("storefronts_tenant_uidx").on(t.tenantId),
  uniqueIndex("storefronts_slug_uidx").on(t.slug),
]);
export type Storefront = typeof storefronts.$inferSelect;
export type NewStorefront = typeof storefronts.$inferInsert;

// tenant_i18n_overrides: per-tenant custom translations for W27 message
// catalog keys (server/services/i18n.ts MESSAGE_CATALOG). Lookup order at
// render time: tenant override → locale pack → en fallback. Additive only.
export const tenantI18nOverrides = pgTable("tenant_i18n_overrides", {
  id:        uuid("id").primaryKey().defaultRandom(),
  tenantId:  varchar("tenant_id", { length: 36 }).notNull(),
  locale:    varchar("locale", { length: 8 }).notNull(),
  key:       varchar("key", { length: 64 }).notNull(),
  text:      text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tenant_i18n_overrides_tenant_locale_key_uidx").on(t.tenantId, t.locale, t.key),
]);
export type TenantI18nOverride = typeof tenantI18nOverrides.$inferSelect;
export type NewTenantI18nOverride = typeof tenantI18nOverrides.$inferInsert;

// === W27 credit ===
// Merchant credit score + micro-loans (working capital) + portable credit
// certificates. See server/services/creditScore.ts (frozen getMerchantScore
// contract) and server/services/tradeCredit/microLoans.ts. ALL money is
// INTEGER CENTS. Additive only; never reorder existing lines above.

// merchant_credit_scores: cached deterministic score snapshot per
// (tenantId, merchantId). Recomputed on demand by getMerchantScore; the
// factors jsonb documents every factor's contribution (integer points).
export const merchantCreditScores = pgTable("merchant_credit_scores", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  merchantId:  varchar("merchant_id", { length: 36 }).notNull(),
  score:       integer("score").notNull(),
  factors:     jsonb("factors").notNull(),
  computedAt:  timestamp("computed_at").notNull().defaultNow(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_credit_scores_tenant_merchant_uniq").on(t.tenantId, t.merchantId),
  index("merchant_credit_scores_tenant_idx").on(t.tenantId),
]);
export type MerchantCreditScore = typeof merchantCreditScores.$inferSelect;
export type NewMerchantCreditScore = typeof merchantCreditScores.$inferInsert;

// merchant_loans: platform micro-loan (working capital) lifecycle.
// status: 'active' | 'repaid' | 'defaulted' | 'cancelled'. Offers are
// computed on the fly from the credit score tier (not stored); a loan row
// appears only once the merchant accepts. repayment_pct is the integer
// percent (1-100) of each future settled sale auto-deducted by the sweep.
export const merchantLoans = pgTable("merchant_loans", {
  id:               uuid("id").primaryKey().defaultRandom(),
  tenantId:         varchar("tenant_id", { length: 36 }).notNull(),
  merchantId:       varchar("merchant_id", { length: 36 }).notNull(),
  status:           varchar("status", { length: 16 }).notNull().default("active"),
  principalCents:   integer("principal_cents").notNull(),
  feeCents:         integer("fee_cents").notNull(),
  outstandingCents: integer("outstanding_cents").notNull(),
  repaymentPct:     integer("repayment_pct").notNull(),
  scoreAtAccept:    integer("score_at_accept").notNull(),
  tier:             varchar("tier", { length: 8 }).notNull(),
  currency:         varchar("currency", { length: 3 }).notNull().default("NGN"),
  walletTxId:       varchar("wallet_tx_id", { length: 36 }),
  disbursedAt:      timestamp("disbursed_at"),
  dueAt:            timestamp("due_at"),
  repaidAt:         timestamp("repaid_at"),
  defaultedAt:      timestamp("defaulted_at"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("merchant_loans_tenant_idx").on(t.tenantId),
  index("merchant_loans_merchant_idx").on(t.tenantId, t.merchantId),
  index("merchant_loans_status_idx").on(t.status),
]);
export type MerchantLoan = typeof merchantLoans.$inferSelect;
export type NewMerchantLoan = typeof merchantLoans.$inferInsert;

// merchant_loan_repayments: append-only repayment ledger. source:
// 'sale_deduction' (auto sweep) | 'manual'. reference is the idempotency
// key — for sale deductions it is `loanrepay:<loanId>:<walletTxId>` so a
// settled sale is never double-charged.
export const merchantLoanRepayments = pgTable("merchant_loan_repayments", {
  id:          uuid("id").primaryKey().defaultRandom(),
  loanId:      uuid("loan_id").notNull().references(() => merchantLoans.id),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  source:      varchar("source", { length: 24 }).notNull(),
  orderId:     varchar("order_id", { length: 36 }),
  walletTxId:  varchar("wallet_tx_id", { length: 36 }),
  reference:   varchar("reference", { length: 160 }).notNull(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_loan_repayments_ref_uniq").on(t.reference),
  index("merchant_loan_repayments_loan_idx").on(t.loanId),
  index("merchant_loan_repayments_tenant_idx").on(t.tenantId),
]);
export type MerchantLoanRepayment = typeof merchantLoanRepayments.$inferSelect;
export type NewMerchantLoanRepayment = typeof merchantLoanRepayments.$inferInsert;

// merchant_credit_certificates: issued portable credit certificates (JSON
// payload + HMAC-SHA256 signature; HTML rendered on demand). Immutable
// once issued — a fresh download issues a new row (audit trail).
export const merchantCreditCertificates = pgTable("merchant_credit_certificates", {
  id:         uuid("id").primaryKey().defaultRandom(),
  tenantId:   varchar("tenant_id", { length: 36 }).notNull(),
  merchantId: varchar("merchant_id", { length: 36 }).notNull(),
  payload:    jsonb("payload").notNull(),
  signature:  varchar("signature", { length: 128 }).notNull(),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("merchant_credit_cert_tenant_idx").on(t.tenantId),
  index("merchant_credit_cert_merchant_idx").on(t.tenantId, t.merchantId),
]);
export type MerchantCreditCertificate = typeof merchantCreditCertificates.$inferSelect;
export type NewMerchantCreditCertificate = typeof merchantCreditCertificates.$inferInsert;
// === W27 delivery-loyalty-reviews (Coder E) ===
// Delivery aggregation, loyalty points and verified reviews. Additive only.
// ALL money is INTEGER CENTS. Points are integers (never fractional).

// ── W27: per-tenant courier adapter configuration ───────────────────────────
// Each row enables a registered courier adapter (see
// server/services/delivery/registry.ts) for a tenant. `credentials` holds
// non-secret config only in cleartext; API keys must be AES-256-GCM encrypted
// by the caller (same discipline as payment_gateway_configs). Higher
// `priority` wins when multiple couriers are enabled.
export const courierConfigs = pgTable("courier_configs", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  courier:     varchar("courier", { length: 50 }).notNull(),
  enabled:     boolean("enabled").notNull().default(true),
  priority:    integer("priority").notNull().default(0),
  credentials: jsonb("credentials"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("courier_configs_tenant_idx").on(t.tenantId),
  uniqueIndex("courier_configs_tenant_courier_idx").on(t.tenantId, t.courier),
]);
export type CourierConfig = typeof courierConfigs.$inferSelect;
export type NewCourierConfig = typeof courierConfigs.$inferInsert;

// ── W27: aggregated delivery bookings ───────────────────────────────────────
// One row per booked dispatch. `quote` snapshots the accepted Quote so the
// fee charged at checkout always reconciles with the booking. feeCents is
// the delivery fee added to the order total (integer cents).
// status: quoted | booked | picked_up | in_transit | delivered | failed | cancelled
export const deliveries = pgTable("deliveries", {
  id:             uuid("id").primaryKey().defaultRandom(),
  tenantId:       varchar("tenant_id", { length: 36 }).notNull(),
  orderId:        varchar("order_id", { length: 36 }).notNull(),
  courier:        varchar("courier", { length: 50 }).notNull(),
  externalId:     varchar("external_id", { length: 128 }),
  status:         varchar("status", { length: 24 }).notNull().default("quoted"),
  feeCents:       integer("fee_cents").notNull(),
  currency:       varchar("currency", { length: 3 }).notNull().default("NGN"),
  distanceKm:     numeric("distance_km", { precision: 8, scale: 3 }),
  quote:          jsonb("quote"),
  pickupAddress:  jsonb("pickup_address"),
  dropoffAddress: jsonb("dropoff_address"),
  recipientPhone: varchar("recipient_phone", { length: 30 }),
  statusHistory:  jsonb("status_history").notNull().default([]),
  bookedAt:       timestamp("booked_at"),
  deliveredAt:    timestamp("delivered_at"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("deliveries_tenant_idx").on(t.tenantId),
  index("deliveries_order_idx").on(t.orderId),
  index("deliveries_status_idx").on(t.tenantId, t.status),
]);
export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;

// ── W27: per-tenant loyalty earn/burn rules ─────────────────────────────────
// earn: pointsPerUnit points per unitValueCents spent (default 1 pt / ₦100).
// burn: pointsValueCents = value of 1 point when redeemed (integer cents);
// redemptionCapPercent caps the discount at that % of the order total.
export const loyaltyRules = pgTable("loyalty_rules", {
  id:                    uuid("id").primaryKey().defaultRandom(),
  tenantId:              varchar("tenant_id", { length: 36 }).notNull(),
  enabled:               boolean("enabled").notNull().default(true),
  pointsPerUnit:         integer("points_per_unit").notNull().default(1),
  unitValueCents:        integer("unit_value_cents").notNull().default(10000),
  pointsValueCents:      integer("points_value_cents").notNull().default(100),
  redemptionCapPercent:  integer("redemption_cap_percent").notNull().default(20),
  createdAt:             timestamp("created_at").notNull().defaultNow(),
  updatedAt:             timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("loyalty_rules_tenant_idx").on(t.tenantId),
]);
export type LoyaltyRule = typeof loyaltyRules.$inferSelect;
export type NewLoyaltyRule = typeof loyaltyRules.$inferInsert;

// ── W27: loyalty points ledger (double-entry style) ─────────────────────────
// Every movement is one row with (debitAccount, creditAccount):
//   earn:   debit "liability:points",      credit "customer:{phone}"
//   redeem: debit "customer:{phone}",      credit "liability:points"
//   adjust: debit "merchant:adjust",       credit "customer:{phone}" (or vice
//           versa for clawbacks — see `points` sign; points is always the
//           absolute movement, `direction` marks earn/redeem/adjust).
// `balanceAfter` snapshots the customer's balance for cheap balance reads.
export const loyaltyLedger = pgTable("loyalty_ledger", {
  id:            uuid("id").primaryKey().defaultRandom(),
  tenantId:      varchar("tenant_id", { length: 36 }).notNull(),
  customerPhone: varchar("customer_phone", { length: 30 }).notNull(),
  entryType:     varchar("entry_type", { length: 16 }).notNull(), // earn|redeem|adjust
  points:        integer("points").notNull(),
  debitAccount:  varchar("debit_account", { length: 96 }).notNull(),
  creditAccount: varchar("credit_account", { length: 96 }).notNull(),
  balanceAfter:  integer("balance_after").notNull(),
  reason:        varchar("reason", { length: 255 }).notNull(),
  orderId:       varchar("order_id", { length: 36 }),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("loyalty_ledger_tenant_idx").on(t.tenantId),
  index("loyalty_ledger_customer_idx").on(t.tenantId, t.customerPhone),
  index("loyalty_ledger_order_idx").on(t.orderId),
  // W30 (V3#9): dup earn/redeem backstop per order.
  uniqueIndex("loyalty_ledger_tenant_phone_order_kind_uniq")
    .on(t.tenantId, t.customerPhone, t.orderId, t.entryType)
    .where(sql`order_id IS NOT NULL`),
]);
export type LoyaltyLedgerEntry = typeof loyaltyLedger.$inferSelect;
export type NewLoyaltyLedgerEntry = typeof loyaltyLedger.$inferInsert;

// ── W27: purchase-verified reviews ──────────────────────────────────────────
// A review row may exist only when the reviewer has a completed/delivered
// order for the merchant (enforced in server/services/reviews.ts). One review
// per (tenant, order, product) — productId '' = merchant-level review.
// status: published | flagged | removed.
export const reviews = pgTable("reviews", {
  id:               uuid("id").primaryKey().defaultRandom(),
  tenantId:         varchar("tenant_id", { length: 36 }).notNull(),
  orderId:          varchar("order_id", { length: 36 }).notNull(),
  productId:        varchar("product_id", { length: 36 }).notNull().default(""),
  customerPhone:    varchar("customer_phone", { length: 30 }).notNull(),
  rating:           integer("rating").notNull(), // 1..5
  text:             text("text"),
  status:           varchar("status", { length: 16 }).notNull().default("published"),
  merchantResponse: text("merchant_response"),
  respondedAt:      timestamp("responded_at"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("reviews_tenant_idx").on(t.tenantId),
  index("reviews_product_idx").on(t.tenantId, t.productId),
  uniqueIndex("reviews_order_product_idx").on(t.tenantId, t.orderId, t.productId),
]);
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
// === END W27 delivery-loyalty-reviews ===
// === W27 B2B WHOLESALE MARKETPLACE + GROUP BUYING ===
// Wholesaler tenants publish bulk listings with MOQ + tiered unit pricing;
// retailer tenants (or WhatsApp buyers) place purchase orders. ALL money is
// INTEGER CENTS. Orders settle via existing order/payment rails; trade-credit
// checkout draws on the existing credit account (server/services/tradeCredit)
// gated by the platform merchant credit score (server/services/creditScore).
// Additive only.
export const wholesaleListings = pgTable("wholesale_listings", {
  id:          uuid("id").primaryKey().defaultRandom(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(), // wholesaler tenant
  productId:   varchar("product_id", { length: 36 }),          // optional catalog link
  title:       varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  category:    varchar("category", { length: 120 }),
  moq:         integer("moq").notNull().default(1),            // minimum order quantity (units)
  currency:    varchar("currency", { length: 8 }).notNull().default("NGN"),
  status:      varchar("status", { length: 16 }).notNull().default("draft"), // 'draft'|'active'|'paused'
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("wholesale_listings_tenant_idx").on(t.tenantId),
  index("wholesale_listings_status_idx").on(t.status),
  index("wholesale_listings_category_idx").on(t.category),
]);
export type WholesaleListing = typeof wholesaleListings.$inferSelect;
export type NewWholesaleListing = typeof wholesaleListings.$inferInsert;

// Tiered unit pricing per listing. [minQty, maxQty] inclusive bands; the
// band with maxQty NULL is open-ended. unitPriceCents is INTEGER CENTS.
export const wholesaleListingTiers = pgTable("wholesale_listing_tiers", {
  id:              uuid("id").primaryKey().defaultRandom(),
  tenantId:        varchar("tenant_id", { length: 36 }).notNull(),
  listingId:       uuid("listing_id").notNull(),
  minQty:          integer("min_qty").notNull(),
  maxQty:          integer("max_qty"),
  unitPriceCents:  integer("unit_price_cents").notNull(),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("wholesale_listing_tiers_listing_idx").on(t.listingId),
  index("wholesale_listing_tiers_tenant_idx").on(t.tenantId),
]);
export type WholesaleListingTier = typeof wholesaleListingTiers.$inferSelect;
export type NewWholesaleListingTier = typeof wholesaleListingTiers.$inferInsert;

// Retailer purchase order against a wholesale listing. totalCents is
// quantity × resolved tier unitPriceCents (integer cents). paymentMode:
// 'pay_now' (existing payment rails) | 'trade_credit' (drawOnCredit).
export const wholesaleOrders = pgTable("wholesale_orders", {
  id:             uuid("id").primaryKey().defaultRandom(),
  tenantId:       varchar("tenant_id", { length: 36 }).notNull(),  // wholesaler (supplier)
  buyerTenantId:  varchar("buyer_tenant_id", { length: 36 }),      // retailer tenant (null for guest phone buyer)
  buyerPhone:     varchar("buyer_phone", { length: 32 }),
  listingId:      uuid("listing_id").notNull(),
  quantity:       integer("quantity").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  totalCents:     integer("total_cents").notNull(),
  currency:       varchar("currency", { length: 8 }).notNull().default("NGN"),
  status:         varchar("status", { length: 20 }).notNull().default("pending"), // 'pending'|'confirmed'|'paid'|'fulfilled'|'cancelled'
  paymentMode:    varchar("payment_mode", { length: 16 }).notNull().default("pay_now"), // 'pay_now'|'trade_credit'
  creditLedgerId: varchar("credit_ledger_id", { length: 64 }),     // set on trade-credit draw
  creditScore:    integer("credit_score"),                         // platform score used at credit checkout
  orderId:        varchar("order_id", { length: 64 }),             // linked row in orders (existing rails)
  notes:          text("notes"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("wholesale_orders_tenant_idx").on(t.tenantId),
  index("wholesale_orders_buyer_idx").on(t.buyerTenantId),
  index("wholesale_orders_listing_idx").on(t.listingId),
  index("wholesale_orders_status_idx").on(t.tenantId, t.status),
]);
export type WholesaleOrder = typeof wholesaleOrders.$inferSelect;
export type NewWholesaleOrder = typeof wholesaleOrders.$inferInsert;

// === W27 GROUP BUYING ===
// A merchant opens a deal: product + bulk price unlocked at thresholdQty by
// deadline. Participants join (payment authorized/held per participant via
// the existing payment/escrow rails); on threshold-met-by-deadline all
// orders confirm, else automatic refunds/voids. ALL money INTEGER CENTS.
export const groupDeals = pgTable("group_deals", {
  id:                uuid("id").primaryKey().defaultRandom(),
  tenantId:          varchar("tenant_id", { length: 36 }).notNull(), // merchant
  productId:         varchar("product_id", { length: 36 }),
  title:             varchar("title", { length: 200 }).notNull(),
  description:       text("description"),
  unitPriceCents:    integer("unit_price_cents").notNull(),   // bulk (discounted) price
  retailPriceCents:  integer("retail_price_cents"),           // reference price for display
  thresholdQty:      integer("threshold_qty").notNull(),      // unlock quantity
  currentQty:        integer("current_qty").notNull().default(0),
  currency:          varchar("currency", { length: 8 }).notNull().default("NGN"),
  deadline:          timestamp("deadline").notNull(),
  status:            varchar("status", { length: 16 }).notNull().default("open"), // 'open'|'confirmed'|'expired'|'cancelled'|'fulfilled'
  createdAt:         timestamp("created_at").notNull().defaultNow(),
  updatedAt:         timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("group_deals_tenant_idx").on(t.tenantId),
  index("group_deals_status_idx").on(t.status),
  index("group_deals_deadline_idx").on(t.deadline),
]);
export type GroupDeal = typeof groupDeals.$inferSelect;
export type NewGroupDeal = typeof groupDeals.$inferInsert;

// One row per participant per deal (unique on deal+phone). amountCents =
// quantity × deal.unitPriceCents. status: 'held' (authorized/held) →
// 'confirmed' (deal won) | 'refunded' | 'voided' (deal lost).
export const groupDealParticipants = pgTable("group_deal_participants", {
  id:            uuid("id").primaryKey().defaultRandom(),
  tenantId:      varchar("tenant_id", { length: 36 }).notNull(),
  dealId:        uuid("deal_id").notNull(),
  customerPhone: varchar("customer_phone", { length: 32 }).notNull(),
  quantity:      integer("quantity").notNull(),
  amountCents:   integer("amount_cents").notNull(),
  currency:      varchar("currency", { length: 8 }).notNull().default("NGN"),
  status:        varchar("status", { length: 16 }).notNull().default("held"), // 'held'|'confirmed'|'refunded'|'voided'
  paymentRef:    varchar("payment_ref", { length: 128 }),
  orderId:       varchar("order_id", { length: 64 }),  // created on deal confirm
  createdAt:     timestamp("created_at").notNull().defaultNow(),
  updatedAt:     timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("group_deal_participants_deal_phone_uniq").on(t.dealId, t.customerPhone),
  index("group_deal_participants_deal_idx").on(t.dealId),
  index("group_deal_participants_tenant_idx").on(t.tenantId),
  index("group_deal_participants_phone_idx").on(t.customerPhone),
]);
export type GroupDealParticipant = typeof groupDealParticipants.$inferSelect;
export type NewGroupDealParticipant = typeof groupDealParticipants.$inferInsert;
// === END W27 B2B WHOLESALE MARKETPLACE + GROUP BUYING ===
// === W27 savings-insurance-vouchers (Coder G) ===
// Stokvel / group savings circles (esusu/ajo/chama), micro-insurance
// (partner-adapter pattern, integer cents) and government/NGO voucher rails.
// Additive only. ALL money is INTEGER CENTS. Full audit trail per circle.

// ── Stokvel circles ─────────────────────────────────────────────────────────
// status: 'active' | 'completed' | 'cancelled'. rotationIndex points at the
// member (by rotationPosition) receiving the CURRENT cycle payout.
export const stokvelCircles = pgTable("stokvel_circles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  contributionAmountCents: integer("contribution_amount_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  frequency: varchar("frequency", { length: 16 }).notNull().default("monthly"), // 'weekly' | 'monthly'
  status: varchar("status", { length: 16 }).notNull().default("active"),
  rotationIndex: integer("rotation_index").notNull().default(0),
  currentCycle: integer("current_cycle").notNull().default(1),
  createdByPhone: varchar("created_by_phone", { length: 32 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("stokvel_circles_tenant_idx").on(t.tenantId),
  index("stokvel_circles_status_idx").on(t.status),
]);
export type StokvelCircle = typeof stokvelCircles.$inferSelect;
export type NewStokvelCircle = typeof stokvelCircles.$inferInsert;

// status: 'active' | 'removed'. rotationPosition is assigned deterministically
// in join order (0-based) unless explicitly provided at creation.
export const stokvelMembers = pgTable("stokvel_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  circleId: uuid("circle_id").notNull().references(() => stokvelCircles.id),
  phone: varchar("phone", { length: 32 }).notNull(),
  name: varchar("name", { length: 160 }),
  rotationPosition: integer("rotation_position").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
}, (t) => [
  unique("stokvel_members_circle_phone_uniq").on(t.circleId, t.phone),
  index("stokvel_members_circle_idx").on(t.circleId),
  index("stokvel_members_phone_idx").on(t.tenantId, t.phone),
]);
export type StokvelMember = typeof stokvelMembers.$inferSelect;
export type NewStokvelMember = typeof stokvelMembers.$inferInsert;

// One row per member per cycle. status: 'pending' | 'paid' | 'missed'.
// Unique (circleId, cycle, memberId) makes double-contribution impossible.
export const stokvelContributions = pgTable("stokvel_contributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  circleId: uuid("circle_id").notNull().references(() => stokvelCircles.id),
  cycle: integer("cycle").notNull(),
  memberId: uuid("member_id").notNull().references(() => stokvelMembers.id),
  phone: varchar("phone", { length: 32 }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  paymentRef: varchar("payment_ref", { length: 128 }),
  paidAt: timestamp("paid_at"),
  reminderCount: integer("reminder_count").notNull().default(0),
  lastReminderAt: timestamp("last_reminder_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("stokvel_contrib_circle_cycle_member_uniq").on(t.circleId, t.cycle, t.memberId),
  index("stokvel_contrib_circle_cycle_idx").on(t.circleId, t.cycle),
  index("stokvel_contrib_status_idx").on(t.status),
]);
export type StokvelContribution = typeof stokvelContributions.$inferSelect;
export type NewStokvelContribution = typeof stokvelContributions.$inferInsert;

// Deterministic rotating payout: exactly one per (circle, cycle) — enforced
// by the unique constraint. status: 'pending' | 'paid' | 'skipped'.
export const stokvelPayouts = pgTable("stokvel_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  circleId: uuid("circle_id").notNull().references(() => stokvelCircles.id),
  cycle: integer("cycle").notNull(),
  memberId: uuid("member_id").notNull().references(() => stokvelMembers.id),
  phone: varchar("phone", { length: 32 }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("stokvel_payout_circle_cycle_uniq").on(t.circleId, t.cycle),
  index("stokvel_payout_circle_idx").on(t.circleId),
]);
export type StokvelPayout = typeof stokvelPayouts.$inferSelect;
export type NewStokvelPayout = typeof stokvelPayouts.$inferInsert;

// Append-only audit trail for every circle mutation.
export const stokvelEvents = pgTable("stokvel_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  circleId: uuid("circle_id").notNull().references(() => stokvelCircles.id),
  actorPhone: varchar("actor_phone", { length: 32 }),
  kind: varchar("kind", { length: 40 }).notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("stokvel_events_circle_idx").on(t.circleId, t.createdAt),
]);
export type StokvelEvent = typeof stokvelEvents.$inferSelect;
export type NewStokvelEvent = typeof stokvelEvents.$inferInsert;

// ── Micro-insurance ─────────────────────────────────────────────────────────
// Partner-sold products configured per tenant. Premium is deterministic:
// max(flatPremiumCents, orderCents * premiumBps / 10000) — integer cents.
export const insuranceProducts = pgTable("insurance_products", {
  id: varchar("id", { length: 64 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  premiumBps: integer("premium_bps").notNull().default(0),
  flatPremiumCents: integer("flat_premium_cents").notNull().default(0),
  coverageCents: integer("coverage_cents").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("insurance_products_tenant_idx").on(t.tenantId),
]);
export type InsuranceProduct = typeof insuranceProducts.$inferSelect;
export type NewInsuranceProduct = typeof insuranceProducts.$inferInsert;

// status: 'quoted' | 'bound' | 'expired'.
export const insuranceQuotes = pgTable("insurance_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  productId: varchar("product_id", { length: 64 }).notNull().references(() => insuranceProducts.id),
  orderId: varchar("order_id", { length: 36 }),
  holderPhone: varchar("holder_phone", { length: 32 }),
  contextJson: jsonb("context_json"),
  premiumCents: integer("premium_cents").notNull(),
  coverageCents: integer("coverage_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: varchar("status", { length: 16 }).notNull().default("quoted"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("insurance_quotes_tenant_idx").on(t.tenantId),
  index("insurance_quotes_order_idx").on(t.orderId),
]);
export type InsuranceQuote = typeof insuranceQuotes.$inferSelect;
export type NewInsuranceQuote = typeof insuranceQuotes.$inferInsert;

// status: 'active' | 'claimed' | 'cancelled' | 'expired'.
export const insurancePolicies = pgTable("insurance_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  policyNumber: varchar("policy_number", { length: 32 }).notNull(),
  quoteId: uuid("quote_id").notNull().references(() => insuranceQuotes.id),
  productId: varchar("product_id", { length: 64 }).notNull().references(() => insuranceProducts.id),
  orderId: varchar("order_id", { length: 36 }),
  holderPhone: varchar("holder_phone", { length: 32 }),
  premiumCents: integer("premium_cents").notNull(),
  coverageCents: integer("coverage_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  boundAt: timestamp("bound_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("insurance_policies_number_uniq").on(t.policyNumber),
  index("insurance_policies_tenant_idx").on(t.tenantId),
  index("insurance_policies_holder_idx").on(t.tenantId, t.holderPhone),
]);
export type InsurancePolicy = typeof insurancePolicies.$inferSelect;
export type NewInsurancePolicy = typeof insurancePolicies.$inferInsert;

// trigger: 'manual' | 'parametric'. status: 'filed' | 'approved' | 'rejected' | 'paid'.
export const insuranceClaims = pgTable("insurance_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  policyId: uuid("policy_id").notNull().references(() => insurancePolicies.id),
  reason: text("reason").notNull(),
  trigger: varchar("trigger", { length: 16 }).notNull().default("manual"),
  status: varchar("status", { length: 16 }).notNull().default("filed"),
  payoutCents: integer("payout_cents"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (t) => [
  index("insurance_claims_policy_idx").on(t.policyId),
  index("insurance_claims_tenant_idx").on(t.tenantId),
]);
export type InsuranceClaim = typeof insuranceClaims.$inferSelect;
export type NewInsuranceClaim = typeof insuranceClaims.$inferInsert;

// ── Government / NGO voucher rails ──────────────────────────────────────────
// A program is created by an issuer (government agency / NGO) with a budget;
// vouchers are issued to eligible recipients and redeemed at checkout against
// category / merchant restrictions. Integer cents; counters kept in lockstep
// inside the same transactions as the voucher rows.
export const voucherPrograms = pgTable("voucher_programs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  issuer: varchar("issuer", { length: 160 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  budgetCents: integer("budget_cents").notNull(),
  issuedCents: integer("issued_cents").notNull().default(0),
  redeemedCents: integer("redeemed_cents").notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  eligiblePhones: jsonb("eligible_phones"), // string[] | null = all phones
  eligibleCategories: jsonb("eligible_categories"), // string[] | null = all
  expiresAt: timestamp("expires_at"),
  status: varchar("status", { length: 16 }).notNull().default("active"), // 'active' | 'closed'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("voucher_programs_tenant_idx").on(t.tenantId),
  index("voucher_programs_status_idx").on(t.status),
]);
export type VoucherProgram = typeof voucherPrograms.$inferSelect;
export type NewVoucherProgram = typeof voucherPrograms.$inferInsert;

// status: 'issued' | 'redeemed' | 'expired' | 'cancelled'. `code` is globally
// unique (deterministic HMAC-derived, see services/vouchers.ts) — the unique
// constraint + transactional status claim prevent double redemption.
export const vouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  programId: uuid("program_id").notNull().references(() => voucherPrograms.id),
  code: varchar("code", { length: 32 }).notNull(),
  recipientPhone: varchar("recipient_phone", { length: 32 }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  status: varchar("status", { length: 16 }).notNull().default("issued"),
  orderId: varchar("order_id", { length: 36 }),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  redeemedAt: timestamp("redeemed_at"),
  expiresAt: timestamp("expires_at"),
}, (t) => [
  unique("vouchers_code_uniq").on(t.code),
  index("vouchers_program_idx").on(t.programId),
  index("vouchers_recipient_idx").on(t.tenantId, t.recipientPhone),
  index("vouchers_status_idx").on(t.status),
]);
export type Voucher = typeof vouchers.$inferSelect;
export type NewVoucher = typeof vouchers.$inferInsert;

// === W28 odoo-sync (Coder A) ===
// Per-tenant Odoo ERP connection config. Secrets: apiKey is AES-256-GCM
// encrypted at rest (encrypt-on-write via services/crypto/secrets, same
// pattern as payment_gateway_configs). syncMode:
//   'push'     → enqueue + send immediately on each event
//   'batch'    → enqueue on event; nightly cron posts summarized entries
//   'ondemand' → enqueue only; merchant triggers "odoo sync now" / portal
// accountMapping jsonb maps platform concepts → Odoo account ids, e.g.
// { incomeAccountId, expenseAccountId, receivableAccountId, paymentJournalId }.
export const odooConfigs = pgTable("odoo_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  url: varchar("url", { length: 255 }).notNull(),
  db: varchar("db", { length: 128 }).notNull(),
  username: varchar("username", { length: 128 }),
  apiKey: text("api_key"), // AES-256-GCM encrypted; never plaintext at rest
  syncMode: varchar("sync_mode", { length: 16 }).notNull().default("ondemand"), // 'push' | 'batch' | 'ondemand'
  accountMapping: jsonb("account_mapping"),
  enabled: boolean("enabled").notNull().default(false),
  lastTestedAt: timestamp("last_tested_at"),
  lastTestOk: boolean("last_test_ok"),
  lastTestError: text("last_test_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("odoo_configs_tenant_uniq").on(t.tenantId),
]);
export type OdooConfig = typeof odooConfigs.$inferSelect;
export type NewOdooConfig = typeof odooConfigs.$inferInsert;

// Exactly-once sync outbox: unique (tenantId, entityType, entityId) means a
// sale/expense/payout/loan disbursement is enqueued at most once; the
// claim-before-send worker transitions pending → sending → sent|failed with
// a deterministic attempt counter (no exponential backoff — retries are
// driven by the cron/ondemand sweeps). status:
//   'pending' | 'sending' | 'sent' | 'failed'
// failed rows surface in the portal reconciliation queue (never silently
// divergent) and can be retried (failed → pending reset).
export const odooSyncOutbox = pgTable("odoo_sync_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  entityType: varchar("entity_type", { length: 24 }).notNull(), // 'sale' | 'expense' | 'payout' | 'loan_disbursement'
  entityId: varchar("entity_id", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lastError: text("last_error"),
  odooRef: varchar("odoo_ref", { length: 64 }), // remote record id after send
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("odoo_sync_outbox_entity_uniq").on(t.tenantId, t.entityType, t.entityId),
  index("odoo_sync_outbox_status_idx").on(t.status),
  index("odoo_sync_outbox_tenant_idx").on(t.tenantId),
]);
export type OdooSyncOutbox = typeof odooSyncOutbox.$inferSelect;
export type NewOdooSyncOutbox = typeof odooSyncOutbox.$inferInsert;
// === END W28 odoo-sync ===

// === W28 medusa-storefront (Coder B) ===
// Per-tenant Medusa store mapping. Lifts the Wave-26 blanket admin-only
// Medusa integration: tenant-scoped procedures resolve their own mapping;
// cross-tenant administration stays admin-only. `catalogSource` toggles the
// storefront catalog between platform-native products and the synced Medusa
// catalog; `apiKeyRef` points at the encrypted credential (tenant_integrations
// row for integrationType "medusa") — plaintext keys never persist here.
export const medusaStoreMappings = pgTable("medusa_store_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  medusaStoreId: varchar("medusa_store_id", { length: 128 }),
  medusaSalesChannelId: varchar("medusa_sales_channel_id", { length: 128 }),
  baseUrl: varchar("base_url", { length: 512 }),
  apiKeyRef: varchar("api_key_ref", { length: 255 }),
  catalogSource: varchar("catalog_source", { length: 16 }).notNull().default("platform"),
  syncEnabled: boolean("sync_enabled").notNull().default(false),
  lastBackfillAt: timestamp("last_backfill_at"),
  lastWebhookAt: timestamp("last_webhook_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("medusa_store_mappings_tenant_uidx").on(t.tenantId),
  index("medusa_store_mappings_source_idx").on(t.tenantId, t.catalogSource),
]);
export type MedusaStoreMapping = typeof medusaStoreMappings.$inferSelect;
export type NewMedusaStoreMapping = typeof medusaStoreMappings.$inferInsert;

// Platform order ↔ Medusa order bridge links. Exactly one outbound Medusa
// order per platform order (tenant+order unique); reverse lookup by
// medusaOrderId feeds the fulfillment webhook → existing delivery/escrow
// release flow (DB state only — escrow.ts untouched).
export const medusaOrderLinks = pgTable("medusa_order_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  orderId: varchar("order_id", { length: 36 }).notNull(),
  medusaOrderId: varchar("medusa_order_id", { length: 128 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("created"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("medusa_order_links_tenant_order_uidx").on(t.tenantId, t.orderId),
  uniqueIndex("medusa_order_links_tenant_medusa_uidx").on(t.tenantId, t.medusaOrderId),
  index("medusa_order_links_order_idx").on(t.orderId),
]);
export type MedusaOrderLink = typeof medusaOrderLinks.$inferSelect;
export type NewMedusaOrderLink = typeof medusaOrderLinks.$inferInsert;
// === END W28 medusa-storefront ===

// === W30 loans-credit (Coder A) ===
// merchant_loan_funding: funding leg for every micro-loan disbursement
// (verify-v1 #12 — no more unbacked minted wallet balance). acceptLoanTx
// atomically decrements credit_facilities.commitment_cents (guarded UPDATE,
// insufficient commitment → honest rejection) and records the leg here in
// the same transaction as the wallet credit. ledger_ref is the deterministic
// TigerBeetle idempotency reference `loanfund:<loanId>`. One row per loan.
// See drizzle/0089_merchant_loan_funding.sql.
export const merchantLoanFunding = pgTable("merchant_loan_funding", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanId: uuid("loan_id").notNull().references(() => merchantLoans.id),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  facilityId: uuid("facility_id").notNull().references(() => creditFacilities.id),
  principalCents: integer("principal_cents").notNull(),
  ledgerRef: varchar("ledger_ref", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_loan_funding_loan_uniq").on(t.loanId),
  index("merchant_loan_funding_facility_idx").on(t.facilityId),
]);
export type MerchantLoanFunding = typeof merchantLoanFunding.$inferSelect;
export type NewMerchantLoanFunding = typeof merchantLoanFunding.$inferInsert;
// === END W30 loans-credit ===
// === W30 escrow-lifecycle ===
// === W30 feature-ring ===
// Sponsored spend billing ledger (V2#16): one row per served sponsored
// placement, debited atomically against sponsored_listings.spent_today_cents
// (guarded conditional UPDATE at serve time in services/geoDiscovery.ts).
// `reference` is the idempotency key (unique) so retries never double-bill.
export const sponsoredSpendEvents = pgTable("sponsored_spend_events", {
  id:          uuid("id").primaryKey().defaultRandom(),
  listingId:   uuid("listing_id").notNull(),
  tenantId:    varchar("tenant_id", { length: 36 }).notNull(),
  spendDate:   varchar("spend_date", { length: 10 }).notNull(), // YYYY-MM-DD (UTC)
  kind:        varchar("kind", { length: 16 }).notNull().default("serve"),
  amountCents: integer("amount_cents").notNull(),
  reference:   varchar("reference", { length: 160 }).notNull(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("sponsored_spend_reference_uniq").on(t.reference),
  index("sponsored_spend_listing_idx").on(t.listingId, t.spendDate),
]);
export type SponsoredSpendEvent = typeof sponsoredSpendEvents.$inferSelect;
export type NewSponsoredSpendEvent = typeof sponsoredSpendEvents.$inferInsert;
// === END W30 feature-ring ===
// === W30 auth-gates ===

// Step-up authentication challenges (V2#2): a fresh OTP to the tenant admin
// phone is required for payout-destination changes, withdrawals above the
// configured threshold, owner role grants, and payment admin overrides.
// Single-use, short-lived, attempt-capped. OTP stored as a keyed hash only.
export const stepUpChallenges = pgTable("step_up_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  /** e.g. "payout_change" | "withdrawal" | "owner_grant" | "payment_override" */
  purpose: varchar("purpose", { length: 40 }).notNull(),
  /** v2 per-OTP-salted HMAC-SHA256 of the code — never the code itself. */
  otpHash: varchar("otp_hash", { length: 160 }).notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumedAt: timestamp("consumed_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("step_up_challenges_tenant_purpose_idx").on(t.tenantId, t.purpose, t.createdAt),
  index("step_up_challenges_user_idx").on(t.userId, t.createdAt),
]);
export type StepUpChallenge = typeof stepUpChallenges.$inferSelect;
export type NewStepUpChallenge = typeof stepUpChallenges.$inferInsert;

// Tenant invite magic-link registry (V2#13): every minted invite token is
// recorded by jti; validation marks it consumed exactly once (single-use)
// and the TTL is capped at 24h. Tokens not in the registry (pre-migration
// links) are rejected in production-like environments.
export const tenantInviteTokens = pgTable("tenant_invite_tokens", {
  jti: varchar("jti", { length: 64 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(),
  issuedBy: varchar("issued_by", { length: 36 }),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("tenant_invite_tokens_tenant_idx").on(t.tenantId, t.createdAt),
]);
export type TenantInviteToken = typeof tenantInviteTokens.$inferSelect;
export type NewTenantInviteToken = typeof tenantInviteTokens.$inferInsert;
// === END W30 auth-gates ===
