-- W28 (Coder B): platform order ↔ Medusa order bridge links.
-- Additive only. Exactly one outbound Medusa order per platform order
-- (unique tenant_id+order_id) and reverse lookup by medusa_order_id for the
-- fulfillment webhook. Status mirrors the Medusa-side lifecycle.
CREATE TABLE IF NOT EXISTS "medusa_order_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"medusa_order_id" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'created' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medusa_order_links_tenant_order_uidx" ON "medusa_order_links" USING btree ("tenant_id","order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medusa_order_links_tenant_medusa_uidx" ON "medusa_order_links" USING btree ("tenant_id","medusa_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medusa_order_links_order_idx" ON "medusa_order_links" USING btree ("order_id");
