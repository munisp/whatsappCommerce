-- W35 infra-receivers (Coder D): telemetry_component_status.
-- ADDITIVE ONLY. Records the latest honest health snapshot per telemetry
-- component (otel-collector, jaeger, prometheus, grafana, alertmanager, and
-- any scraped/traced infra component), written by whatever probes them
-- (e.g. the infraHealth probes). tenant_id is nullable: most telemetry
-- components are platform-scoped, not tenant-scoped — NULL = platform-wide.
CREATE TABLE IF NOT EXISTS "telemetry_component_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36),
	"component" text NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_component_status_component_idx" ON "telemetry_component_status" USING btree ("component");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_component_status_tenant_idx" ON "telemetry_component_status" USING btree ("tenant_id");
