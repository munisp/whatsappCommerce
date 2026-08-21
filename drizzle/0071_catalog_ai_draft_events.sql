-- W27 catalog-ai: draft lifecycle audit events.
CREATE TABLE IF NOT EXISTS "catalog_ai_draft_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"event" varchar(24) NOT NULL,
	"actor" varchar(64),
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "catalog_ai_draft_events_draft_idx" ON "catalog_ai_draft_events" USING btree ("draft_id");
CREATE INDEX IF NOT EXISTS "catalog_ai_draft_events_tenant_idx" ON "catalog_ai_draft_events" USING btree ("tenant_id");
