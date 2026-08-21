-- W28 (Coder A): Odoo ERP sync — per-tenant connection config.
-- Additive only. api_key is AES-256-GCM encrypted at rest (encrypt-on-write).
CREATE TABLE IF NOT EXISTS "odoo_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"url" varchar(255) NOT NULL,
	"db" varchar(128) NOT NULL,
	"username" varchar(128),
	"api_key" text,
	"sync_mode" varchar(16) DEFAULT 'ondemand' NOT NULL,
	"account_mapping" jsonb,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp,
	"last_test_ok" boolean,
	"last_test_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "odoo_configs_tenant_uniq" UNIQUE("tenant_id")
);
