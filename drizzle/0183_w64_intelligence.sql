-- === W64 intelligence: R1 recsys co-purchase pairs, R5 clickstream +
-- search-query logging, R9 proactive-nudge idempotency. Additive only;
-- IF NOT EXISTS everywhere for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "copurchase_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"pair_product_id" varchar(36) NOT NULL,
	"co_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copurchase_pairs_uniq" ON "copurchase_pairs" ("tenant_id", "product_id", "pair_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copurchase_pairs_product_idx" ON "copurchase_pairs" ("tenant_id", "product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ui_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36),
	"user_id" varchar(64),
	"session_id" varchar(64),
	"app" varchar(32),
	"page" varchar(255) NOT NULL,
	"action" varchar(64) NOT NULL,
	"dwell_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ui_events_tenant_created_idx" ON "ui_events" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ui_events_page_idx" ON "ui_events" ("page");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36),
	"user_id" varchar(64),
	"channel" varchar(16),
	"query" varchar(512) NOT NULL,
	"results_count" integer,
	"zero_result" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_tenant_created_idx" ON "search_queries" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_zero_idx" ON "search_queries" ("zero_result");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"nudge_type" varchar(32) NOT NULL,
	"subject_id" varchar(128) NOT NULL,
	"day" varchar(10) NOT NULL,
	"channel" varchar(16),
	"status" varchar(16) DEFAULT 'sent' NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proactive_nudges_idem_uniq" ON "proactive_nudges" ("tenant_id", "nudge_type", "subject_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proactive_nudges_tenant_idx" ON "proactive_nudges" ("tenant_id");
