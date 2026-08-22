-- W28 (Coder B): per-tenant Medusa store mappings.
-- Additive only. One mapping row per tenant; lifts the blanket admin-only
-- Medusa integration by letting each tenant resolve its own store mapping.
CREATE TABLE IF NOT EXISTS "medusa_store_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"medusa_store_id" varchar(128),
	"medusa_sales_channel_id" varchar(128),
	"base_url" varchar(512),
	"api_key_ref" varchar(255),
	"catalog_source" varchar(16) DEFAULT 'platform' NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"last_backfill_at" timestamp,
	"last_webhook_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medusa_store_mappings_tenant_uidx" ON "medusa_store_mappings" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medusa_store_mappings_source_idx" ON "medusa_store_mappings" USING btree ("tenant_id","catalog_source");
