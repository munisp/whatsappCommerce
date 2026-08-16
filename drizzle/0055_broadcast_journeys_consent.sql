-- W17 F8: Broadcast journeys + consent tooling.
-- Additive: new broadcast_journeys / broadcast_journey_runs tables, new enums,
-- and GDPR/NDPR-grade consent columns (scope/source/granted_at/withdrawn_at).
CREATE TYPE "public"."journey_status" AS ENUM('draft', 'active', 'paused', 'archived');
CREATE TYPE "public"."journey_run_state" AS ENUM('waiting', 'done', 'exited', 'failed');

ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "scope" varchar(40) DEFAULT 'marketing' NOT NULL;
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "source" varchar(60);
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "granted_at" timestamp;
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp;

CREATE TABLE IF NOT EXISTS "broadcast_journeys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "journey_status" DEFAULT 'draft' NOT NULL,
	"steps" jsonb NOT NULL,
	"entryAudience" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "broadcast_journey_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"journeyId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerId" varchar(36) NOT NULL,
	"currentStep" integer DEFAULT 0 NOT NULL,
	"state" "journey_run_state" DEFAULT 'waiting' NOT NULL,
	"context" jsonb,
	"nextRunAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "broadcast_journeys_tenant_idx" ON "broadcast_journeys" USING btree ("tenantId");
CREATE INDEX IF NOT EXISTS "broadcast_journeys_status_idx" ON "broadcast_journeys" USING btree ("status");
CREATE INDEX IF NOT EXISTS "broadcast_journey_runs_journey_idx" ON "broadcast_journey_runs" USING btree ("journeyId");
CREATE INDEX IF NOT EXISTS "broadcast_journey_runs_tenant_idx" ON "broadcast_journey_runs" USING btree ("tenantId");
CREATE INDEX IF NOT EXISTS "broadcast_journey_runs_due_idx" ON "broadcast_journey_runs" USING btree ("state","nextRunAt");
