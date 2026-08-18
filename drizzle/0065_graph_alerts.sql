-- W22: graph-based collusion detection for the credit/anti-gaming stack.
-- graph_alerts: alerts emitted by server/services/graphCollusion.ts when the
-- tenant-level trade-interaction graph shows collusion signals (cycles,
-- concentration, tight clusters). Idempotent per
-- (tenant_id, buyer_id, signal, window_bucket) via unique index so
-- re-scanning the same window bucket never duplicates an alert.
-- Additive only.
CREATE TABLE IF NOT EXISTS "graph_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"buyer_id" varchar(36) NOT NULL,
	"signal" varchar(100) NOT NULL,
	"score" double precision NOT NULL,
	"evidence_jsonb" jsonb,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"window_bucket" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "graph_alerts_tenant_buyer_signal_bucket_uniq" ON "graph_alerts" USING btree ("tenant_id","buyer_id","signal","window_bucket");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "graph_alerts_tenant_idx" ON "graph_alerts" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "graph_alerts_tenant_status_idx" ON "graph_alerts" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "graph_alerts_buyer_idx" ON "graph_alerts" USING btree ("buyer_id");
