CREATE TYPE "public"."conversation_status" AS ENUM('open', 'resolved', 'pending', 'snoozed', 'bot_active', 'human_active');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."menu_item_type" AS ENUM('section', 'button', 'list_item', 'quick_reply', 'catalog_link', 'url');--> statement-breakpoint
CREATE TYPE "public"."menu_push_status" AS ENUM('idle', 'pushing', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."menu_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('initiated', 'pending', 'completed', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('mojaloop', 'stripe', 'paystack', 'flutterwave', 'manual');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'initiated', 'completed', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('healthy', 'degraded', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."template_category" AS ENUM('order_confirmation', 'shipping_update', 'payment_reminder', 'welcome', 'promotion', 'support', 'custom');--> statement-breakpoint
CREATE TYPE "public"."tenant_plan" AS ENUM('starter', 'growth', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'trial', 'churned');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin', 'operator', 'analyst');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"conversationId" varchar(36) NOT NULL,
	"eventType" varchar(100) NOT NULL,
	"intentType" varchar(100),
	"confidence" numeric(4, 3),
	"latencyMs" integer,
	"escalated" boolean DEFAULT false NOT NULL,
	"toolCalls" jsonb,
	"inputTokens" integer,
	"outputTokens" integer,
	"model" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerId" varchar(36) NOT NULL,
	"chatwootConversationId" varchar(64),
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"channel" varchar(30) DEFAULT 'whatsapp' NOT NULL,
	"assignedAgentId" varchar(64),
	"currentFlowStep" varchar(100) DEFAULT 'greeting',
	"lastIntent" varchar(100),
	"cartId" varchar(36),
	"messageCount" integer DEFAULT 0 NOT NULL,
	"aiHandled" boolean DEFAULT true NOT NULL,
	"escalatedAt" timestamp,
	"resolvedAt" timestamp,
	"firstResponseAt" timestamp,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"whatsappPhone" varchar(30) NOT NULL,
	"name" varchar(255),
	"email" varchar(320),
	"language" varchar(10) DEFAULT 'en',
	"crmContactId" varchar(64),
	"totalOrders" integer DEFAULT 0 NOT NULL,
	"totalSpent" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"lastOrderAt" timestamp,
	"tags" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odoo_integrations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"baseUrl" varchar(512) NOT NULL,
	"database" varchar(128) NOT NULL,
	"username" varchar(255) NOT NULL,
	"apiKey" varchar(512) NOT NULL,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"lastSyncAt" timestamp,
	"syncProducts" boolean DEFAULT true NOT NULL,
	"syncOrders" boolean DEFAULT true NOT NULL,
	"syncInvoices" boolean DEFAULT true NOT NULL,
	"whatsappEnabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "odoo_integrations_tenantId_unique" UNIQUE("tenantId")
);
--> statement-breakpoint
CREATE TABLE "odoo_synced_invoices" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"odooId" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"partnerName" varchar(255),
	"partnerPhone" varchar(30),
	"state" varchar(50),
	"amountTotal" numeric(14, 2),
	"amountResidual" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"invoiceDate" timestamp,
	"dueDate" timestamp,
	"whatsappSent" boolean DEFAULT false NOT NULL,
	"rawData" jsonb,
	"syncedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odoo_synced_orders" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"odooId" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"partnerName" varchar(255),
	"partnerPhone" varchar(30),
	"state" varchar(50),
	"amountTotal" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"dateOrder" timestamp,
	"whatsappSent" boolean DEFAULT false NOT NULL,
	"localOrderId" varchar(36),
	"rawData" jsonb,
	"syncedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odoo_synced_products" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"odooId" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"internalRef" varchar(100),
	"price" numeric(12, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"category" varchar(255),
	"stockQty" numeric(12, 2),
	"active" boolean DEFAULT true NOT NULL,
	"localProductId" varchar(36),
	"rawData" jsonb,
	"syncedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerId" varchar(36) NOT NULL,
	"conversationId" varchar(36),
	"orderNumber" varchar(50) NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"totalAmount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"paymentStatus" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"paymentIntentId" varchar(64),
	"shippingAddress" jsonb,
	"items" jsonb,
	"notes" text,
	"erpOrderId" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"customerId" varchar(36) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"provider" "payment_provider" DEFAULT 'stripe' NOT NULL,
	"status" "payment_intent_status" DEFAULT 'initiated' NOT NULL,
	"providerPaymentId" varchar(256),
	"idempotencyKey" varchar(128) NOT NULL,
	"ledgerPendingId" varchar(36),
	"failureReason" text,
	"metadata" jsonb,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_idempotencyKey_unique" UNIQUE("idempotencyKey")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"sku" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"price" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"imageUrl" text,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"stockQuantity" integer DEFAULT 0 NOT NULL,
	"lowStockThreshold" integer DEFAULT 10,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"serviceName" varchar(100) NOT NULL,
	"status" "service_status" DEFAULT 'unknown' NOT NULL,
	"latencyMs" integer,
	"errorRate" numeric(5, 2),
	"lastCheckedAt" timestamp DEFAULT now() NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "tenant_menu_assignments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"menuId" varchar(36) NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"assignedAt" timestamp DEFAULT now() NOT NULL,
	"assignedBy" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"plan" "tenant_plan" DEFAULT 'starter' NOT NULL,
	"status" "tenant_status" DEFAULT 'trial' NOT NULL,
	"whatsappPhoneNumberId" varchar(64),
	"whatsappBusinessAccountId" varchar(64),
	"webhookVerifyToken" varchar(128),
	"chatwootAccountId" varchar(64),
	"chatwootApiToken" varchar(256),
	"defaultCurrency" varchar(3) DEFAULT 'USD' NOT NULL,
	"defaultLanguage" varchar(10) DEFAULT 'en' NOT NULL,
	"aiEnabled" boolean DEFAULT true NOT NULL,
	"aiModel" varchar(64) DEFAULT 'gpt-4o-mini',
	"settings" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "twenty_contacts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"twentyId" varchar(64) NOT NULL,
	"name" varchar(255),
	"email" varchar(320),
	"phone" varchar(30),
	"company" varchar(255),
	"jobTitle" varchar(255),
	"stage" varchar(100),
	"whatsappPhone" varchar(30),
	"lastWhatsappAt" timestamp,
	"customerId" varchar(36),
	"rawData" jsonb,
	"syncedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twenty_deals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"twentyId" varchar(64) NOT NULL,
	"name" varchar(255),
	"stage" varchar(100),
	"amount" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"contactId" varchar(36),
	"closeDate" timestamp,
	"probability" integer,
	"rawData" jsonb,
	"syncedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twenty_integrations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"baseUrl" varchar(512) NOT NULL,
	"apiKey" varchar(512) NOT NULL,
	"workspaceId" varchar(64),
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"lastSyncAt" timestamp,
	"syncContacts" boolean DEFAULT true NOT NULL,
	"syncDeals" boolean DEFAULT true NOT NULL,
	"whatsappEnabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "twenty_integrations_tenantId_unique" UNIQUE("tenantId")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"tenantId" varchar(36),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"source" varchar(50) NOT NULL,
	"eventType" varchar(100) NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"payload" jsonb,
	"processingError" text,
	"processedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_menu_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"menuId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"parentId" varchar(36),
	"type" "menu_item_type" DEFAULT 'button' NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"payload" varchar(255),
	"url" text,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_menus" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" "menu_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"publishedAt" timestamp,
	"lastPushedAt" timestamp,
	"pushStatus" "menu_push_status" DEFAULT 'idle' NOT NULL,
	"pushError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"category" "template_category" DEFAULT 'custom' NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"headerText" varchar(255),
	"bodyText" text NOT NULL,
	"footerText" varchar(255),
	"variables" jsonb,
	"buttons" jsonb,
	"isActive" boolean DEFAULT true NOT NULL,
	"usageCount" integer DEFAULT 0 NOT NULL,
	"lastUsedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_events_tenant_idx" ON "agent_events" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "agent_events_conversation_idx" ON "agent_events" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX "agent_events_created_idx" ON "agent_events" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "conversations_tenant_idx" ON "conversations" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conversations_customer_idx" ON "conversations" USING btree ("customerId");--> statement-breakpoint
CREATE INDEX "customers_tenant_idx" ON "customers" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_phone_idx" ON "customers" USING btree ("tenantId","whatsappPhone");--> statement-breakpoint
CREATE INDEX "odoo_integrations_tenant_idx" ON "odoo_integrations" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "odoo_invoices_tenant_idx" ON "odoo_synced_invoices" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_invoices_odoo_id_idx" ON "odoo_synced_invoices" USING btree ("tenantId","odooId");--> statement-breakpoint
CREATE INDEX "odoo_orders_tenant_idx" ON "odoo_synced_orders" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_orders_odoo_id_idx" ON "odoo_synced_orders" USING btree ("tenantId","odooId");--> statement-breakpoint
CREATE INDEX "odoo_products_tenant_idx" ON "odoo_synced_products" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_products_odoo_id_idx" ON "odoo_synced_products" USING btree ("tenantId","odooId");--> statement-breakpoint
CREATE INDEX "orders_tenant_idx" ON "orders" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customerId");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_idx" ON "orders" USING btree ("tenantId","orderNumber");--> statement-breakpoint
CREATE INDEX "payment_intents_tenant_idx" ON "payment_intents" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "payment_intents_status_idx" ON "payment_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_intents_order_idx" ON "payment_intents" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX "products_tenant_idx" ON "products" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_sku_idx" ON "products" USING btree ("tenantId","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "service_health_name_idx" ON "service_health" USING btree ("serviceName");--> statement-breakpoint
CREATE INDEX "tenant_menu_assign_tenant_idx" ON "tenant_menu_assignments" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_menu_assign_unique_idx" ON "tenant_menu_assignments" USING btree ("tenantId","menuId");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tenants_plan_idx" ON "tenants" USING btree ("plan");--> statement-breakpoint
CREATE INDEX "twenty_contacts_tenant_idx" ON "twenty_contacts" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "twenty_contacts_twenty_id_idx" ON "twenty_contacts" USING btree ("tenantId","twentyId");--> statement-breakpoint
CREATE INDEX "twenty_deals_tenant_idx" ON "twenty_deals" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "twenty_deals_twenty_id_idx" ON "twenty_deals" USING btree ("tenantId","twentyId");--> statement-breakpoint
CREATE INDEX "twenty_integrations_tenant_idx" ON "twenty_integrations" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "webhook_events_tenant_idx" ON "webhook_events" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "menu_items_menu_idx" ON "whatsapp_menu_items" USING btree ("menuId");--> statement-breakpoint
CREATE INDEX "menu_items_tenant_idx" ON "whatsapp_menu_items" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "menu_items_parent_idx" ON "whatsapp_menu_items" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX "whatsapp_menus_tenant_idx" ON "whatsapp_menus" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "whatsapp_menus_status_idx" ON "whatsapp_menus" USING btree ("status");--> statement-breakpoint
CREATE INDEX "templates_tenant_idx" ON "whatsapp_templates" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "templates_category_idx" ON "whatsapp_templates" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_tenant_name_idx" ON "whatsapp_templates" USING btree ("tenantId","name");