-- W20: ML/statistical anomaly detection over the SOC2 audit stream.
-- anomaly_alerts: alerts emitted by server/services/auditAnomaly.ts when a
-- tenant's audit_chain traffic deviates from its learned baseline.
-- Idempotent per (tenant_id, signal, window_bucket) via unique index so
-- re-scanning the same window bucket never duplicates an alert.
-- Additive only.
CREATE TABLE IF NOT EXISTS "anomaly_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"signal" varchar(100) NOT NULL,
	"score" double precision NOT NULL,
	"detail_jsonb" jsonb,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"window_bucket" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "anomaly_alerts_tenant_signal_bucket_uniq" ON "anomaly_alerts" USING btree ("tenant_id","signal","window_bucket");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anomaly_alerts_tenant_idx" ON "anomaly_alerts" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anomaly_alerts_tenant_status_idx" ON "anomaly_alerts" USING btree ("tenant_id","status");
