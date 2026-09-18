-- === W46 inventory-depth (ORD-15/16/20/21) ===
-- ORD-15: products."barcode" + product_variants (variant-level stock rows,
-- claim-first reservation by variantId) + inventory_reservations."variantId".
-- ORD-16: warehouses + warehouse_stock (allocation at reserve time; mig 0158
-- backfills a single default warehouse per tenant with existing stock).
-- ORD-20: delivery_claims (shipmentId, photos, type, resolution state machine:
-- open → under_review → approved|rejected → resolved).
-- ORD-21: inventory_batches (productId + expiryDate + qty; FEFO reserve;
-- expiry sweep alert). ADDITIVE ONLY.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "barcode" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_barcode_idx" ON "products" USING btree ("tenantId","barcode");
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD COLUMN IF NOT EXISTS "variantId" varchar(36);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_variants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"sku" varchar(100) NOT NULL,
	"name" varchar(255),
	"attributes" jsonb,
	"barcode" varchar(64),
	"stockQuantity" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_tenant_sku_uniq" ON "product_variants" USING btree ("tenantId","sku");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variants_product_idx" ON "product_variants" USING btree ("productId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variants_barcode_idx" ON "product_variants" USING btree ("tenantId","barcode");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warehouses" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouses_tenant_idx" ON "warehouses" USING btree ("tenantId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warehouse_stock" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"warehouseId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"variantId" varchar(36) DEFAULT '' NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_stock_qty_chk" CHECK ("qty" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_stock_uniq" ON "warehouse_stock" USING btree ("tenantId","warehouseId","productId","variantId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_stock_product_idx" ON "warehouse_stock" USING btree ("tenantId","productId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_claims" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"shipmentId" varchar(36) NOT NULL,
	"orderId" varchar(36),
	"type" varchar(16) NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"resolution" varchar(20),
	"reportedBy" varchar(64),
	"resolvedBy" varchar(64),
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_claims_tenant_idx" ON "delivery_claims" USING btree ("tenantId","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_claims_shipment_idx" ON "delivery_claims" USING btree ("shipmentId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_batches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"batchCode" varchar(64),
	"qty" integer DEFAULT 0 NOT NULL,
	"expiryDate" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_batches_qty_chk" CHECK ("qty" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_batches_product_expiry_idx" ON "inventory_batches" USING btree ("tenantId","productId","expiryDate");
