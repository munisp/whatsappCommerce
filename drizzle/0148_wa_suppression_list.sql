-- W45 messaging-services (Coder A2): durable per-tenant WA suppression list.
-- Additive-only; idempotent (IF NOT EXISTS) like the rest of the chain.
CREATE TABLE IF NOT EXISTS "wa_suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"reason_code" varchar(16),
	"source" varchar(32) DEFAULT 'delivery_receipt' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_suppression_tenant_idx" ON "wa_suppression_list" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wa_suppression_tenant_phone_uq" ON "wa_suppression_list" USING btree ("tenant_id","phone");
