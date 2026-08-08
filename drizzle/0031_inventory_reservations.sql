-- ============================================================
-- Migration 0031: Pre-payment inventory reservations
-- Atomic stock reservations backing the "never take payment for
-- items that don't exist in stock" invariant:
--   1. products.stockQuantity — on-hand units (defensive add; the
--      column already exists in the schema, this keeps the
--      migration self-contained and idempotent).
--   2. inventory_reservations — one row per (order, product) hold.
--      Stock is decremented atomically at reserve time
--      (UPDATE ... WHERE stockQuantity >= qty), flipped to
--      'committed' on payment confirmation, and released (stock
--      credited back) on cancel / payment failure / expiry.
-- All statements are idempotent.
-- ============================================================

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stockQuantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_reservations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"qty" integer NOT NULL,
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_status_check" CHECK ("status" IN ('reserved', 'committed', 'released')),
	CONSTRAINT "inventory_reservations_qty_check" CHECK ("qty" > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_reservations_tenant_idx" ON "inventory_reservations" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_reservations_order_idx" ON "inventory_reservations" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_reservations_status_expires_idx" ON "inventory_reservations" USING btree ("status","expiresAt");
