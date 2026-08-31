-- W33 embedded-api (Coder C): Embedded AP-as-a-feature API clients.
-- Each client is a partner-platform credential bound to exactly ONE tenant
-- it serves (partners create per-merchant clients). api_key_hash stores ONLY
-- the SHA-256 hex digest of the API key — plaintext is returned once at
-- creation/rotation and never persisted. scopes is a subset of:
-- bills:read bills:write payments:read payments:write invoices:read invoices:write
CREATE TABLE IF NOT EXISTS "embedded_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_name" varchar(160) NOT NULL,
	"api_key_hash" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "embedded_clients_api_key_hash_uniq" ON "embedded_clients" USING btree ("api_key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embedded_clients_tenant_idx" ON "embedded_clients" USING btree ("tenant_id");
