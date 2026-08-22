-- W28 (Coder A): Odoo ERP sync — exactly-once sync outbox.
-- Unique (tenant_id, entity_type, entity_id) = each business event enqueued
-- at most once; claim-before-send worker; failed rows = reconciliation queue.
CREATE TABLE IF NOT EXISTS "odoo_sync_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"entity_type" varchar(24) NOT NULL,
	"entity_id" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"odoo_ref" varchar(64),
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "odoo_sync_outbox_entity_uniq" UNIQUE("tenant_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "odoo_sync_outbox_status_idx" ON "odoo_sync_outbox" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "odoo_sync_outbox_tenant_idx" ON "odoo_sync_outbox" USING btree ("tenant_id");
