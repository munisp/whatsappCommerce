import {
  boolean,
  decimal,
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
  uniqueIndex,
  numeric,
} from "drizzle-orm/pg-core";
import { uuid } from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum("user_role", ["user", "admin", "operator", "analyst"]);
export const tenantPlanEnum = pgEnum("tenant_plan", ["starter", "growth", "enterprise"]);
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "trial", "churned"]);
export const productStatusEnum = pgEnum("product_status", ["active", "inactive", "archived"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "resolved", "pending", "snoozed", "bot_active", "human_active"]);
export const orderStatusEnum = pgEnum("order_status", ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"]);
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "initiated", "completed", "failed", "refunded"]);
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
  role: userRoleEnum("role").default("user").notNull(),
  tenantId: varchar("tenantId", { length: 36 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

// ─── Tenants ──────────────────────────────────────────────────────────────────
export const tenants = pgTable("tenants", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  plan: tenantPlanEnum("plan").default("starter").notNull(),
  status: tenantStatusEnum("status").default("trial").notNull(),
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("tenants_status_idx").on(t.status),
  index("tenants_plan_idx").on(t.plan),
]);
// ─── Tenant SSO Provisioning ──────────────────────────────────────────────────
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
  notes: text("notes"),
  erpOrderId: varchar("erpOrderId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("orders_tenant_idx").on(t.tenantId),
  index("orders_status_idx").on(t.status),
  index("orders_customer_idx").on(t.customerId),
  uniqueIndex("orders_number_idx").on(t.tenantId, t.orderNumber),
]);

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
});

export const cartItems = pgTable("cart_items", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  cartSessionId: varchar("cartSessionId", { length: 36 }).notNull().references(() => cartSessions.id, { onDelete: "cascade" }),
  productId: varchar("productId", { length: 36 }).notNull(),
  productName: varchar("productName", { length: 255 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

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
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

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
});

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
});

// ── Order items (normalised) ──────────────────────────────────────────────────
export const orderItems = pgTable("order_items", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: varchar("orderId", { length: 36 }).notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: varchar("productId", { length: 36 }).notNull(),
  productName: varchar("productName", { length: 255 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
});

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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => [
  index("pgc_tenant_idx").on(t.tenantId),
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
