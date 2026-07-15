CREATE TYPE "public"."medusa_onboarding_status" AS ENUM('draft', 'syncing', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."odoo_medusa_bridge_sync_status" AS ENUM('pending', 'syncing', 'synced', 'conflict', 'failed');--> statement-breakpoint
CREATE TYPE "public"."visual_inventory_status" AS ENUM('processing', 'completed', 'failed', 'review_needed');--> statement-breakpoint
CREATE TABLE "medusa_product_onboarding" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"productId" varchar(36),
	"medusaProductId" varchar(128),
	"medusaVariantId" varchar(128),
	"medusaInventoryItemId" varchar(128),
	"title" varchar(256) NOT NULL,
	"description" text,
	"sku" varchar(64),
	"price" numeric(12, 2) NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"stockQuantity" integer DEFAULT 0 NOT NULL,
	"weight" numeric(8, 2),
	"images" jsonb DEFAULT '[]'::jsonb,
	"categories" jsonb DEFAULT '[]'::jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"status" "medusa_onboarding_status" DEFAULT 'draft' NOT NULL,
	"errorMessage" text,
	"syncedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odoo_medusa_inventory_bridge" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"odooProductId" varchar(64) NOT NULL,
	"odooProductName" varchar(256),
	"odooSku" varchar(64),
	"odooStockQty" numeric(12, 2) DEFAULT '0',
	"odooReservedQty" numeric(12, 2) DEFAULT '0',
	"odooWarehouse" varchar(128),
	"medusaProductId" varchar(128),
	"medusaVariantId" varchar(128),
	"medusaInventoryItemId" varchar(128),
	"medusaStockableQty" integer DEFAULT 0,
	"syncStatus" "odoo_medusa_bridge_sync_status" DEFAULT 'pending' NOT NULL,
	"syncDirection" varchar(16) DEFAULT 'odoo_to_medusa',
	"conflictReason" text,
	"lastSyncedAt" timestamp,
	"lastOdooUpdate" timestamp,
	"lastMedusaUpdate" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visual_inventory_mappings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"detectedLabel" varchar(256) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"productName" varchar(256),
	"confidence" real DEFAULT 1,
	"isVerified" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visual_inventory_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"userId" varchar(36),
	"imageUrl" text NOT NULL,
	"imageKey" varchar(256),
	"status" "visual_inventory_status" DEFAULT 'processing' NOT NULL,
	"detectedItems" jsonb DEFAULT '[]'::jsonb,
	"totalItemsDetected" integer DEFAULT 0,
	"vlmAnalysis" text,
	"modelUsed" varchar(64),
	"processingMs" integer,
	"appliedToInventory" boolean DEFAULT false NOT NULL,
	"appliedAt" timestamp,
	"appliedBy" varchar(36),
	"inventoryUpdates" jsonb DEFAULT '[]'::jsonb,
	"notes" text,
	"errorMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "medusa_onboarding_tenant_idx" ON "medusa_product_onboarding" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "medusa_onboarding_product_idx" ON "medusa_product_onboarding" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "odoo_medusa_bridge_tenant_idx" ON "odoo_medusa_inventory_bridge" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "odoo_medusa_bridge_odoo_idx" ON "odoo_medusa_inventory_bridge" USING btree ("odooProductId");--> statement-breakpoint
CREATE INDEX "odoo_medusa_bridge_medusa_idx" ON "odoo_medusa_inventory_bridge" USING btree ("medusaVariantId");--> statement-breakpoint
CREATE INDEX "visual_inventory_mapping_tenant_idx" ON "visual_inventory_mappings" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "visual_inventory_mapping_unique_idx" ON "visual_inventory_mappings" USING btree ("tenantId","detectedLabel");--> statement-breakpoint
CREATE INDEX "visual_inventory_tenant_idx" ON "visual_inventory_sessions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "visual_inventory_status_idx" ON "visual_inventory_sessions" USING btree ("status");