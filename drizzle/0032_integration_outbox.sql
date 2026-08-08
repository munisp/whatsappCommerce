-- ============================================================
-- Migration 0032: integration_events — transactional outbox for
-- bidirectional Medusa / Twenty CRM / Odoo sync.
--
-- Every outbound change (order created/confirmed, customer or
-- product upsert) is first recorded here (direction='out',
-- status='pending') and delivered asynchronously by the outbox
-- dispatcher, so no event is ever lost fire-and-forget. Inbound
-- webhook payloads are recorded too (direction='in') for audit.
--
-- Additive only; all statements are idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"system" text NOT NULL,
	"direction" text NOT NULL,
	"entity" text NOT NULL,
	"entityId" text,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"processedAt" timestamp,
	CONSTRAINT "integration_events_system_check" CHECK ("system" IN ('medusa', 'twenty', 'odoo')),
	CONSTRAINT "integration_events_direction_check" CHECK ("direction" IN ('out', 'in')),
	CONSTRAINT "integration_events_status_check" CHECK ("status" IN ('pending', 'delivered', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_events_status_attempts_idx" ON "integration_events" ("status", "attempts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_events_tenant_idx" ON "integration_events" ("tenantId");
