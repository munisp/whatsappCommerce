-- W19: SOC2 server-side compliance controls.
-- audit_chain: tamper-evident, hash-chained append-only audit log
--   (hash = sha256(prev_hash + canonical fields); see server/services/auditChain.ts).
-- retention_policies: per-(tenant, entity) retention window + legal hold
--   consumed by server/services/retention.ts (preview/execute purge).
-- incidents: security/availability incident register with status machine
--   open → investigating → mitigated → resolved.
-- Additive only.
CREATE TABLE IF NOT EXISTS "audit_chain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36),
	"event_type" varchar(100) NOT NULL,
	"actor_id" varchar(64),
	"payload_jsonb" jsonb,
	"prev_hash" varchar(64) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_chain_tenant_idx" ON "audit_chain" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_chain_created_idx" ON "audit_chain" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_chain_event_type_idx" ON "audit_chain" USING btree ("event_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"entity" varchar(64) NOT NULL,
	"retention_days" integer NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retention_policies_tenant_entity_uniq" ON "retention_policies" USING btree ("tenant_id","entity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retention_policies_tenant_idx" ON "retention_policies" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"severity" varchar(20) DEFAULT 'low' NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_tenant_idx" ON "incidents" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_tenant_status_idx" ON "incidents" USING btree ("tenant_id","status");
