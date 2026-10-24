-- === W66 learning === R6/R8: intent-miss review queue, dispute-outcome
-- risk features, lakehouse incremental export watermarks. Additive-only.
CREATE TABLE IF NOT EXISTS "intent_misses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"session_id" varchar(64),
	"channel" varchar(16),
	"message" text NOT NULL,
	"detected_intent" varchar(64),
	"confidence" real,
	"language" varchar(16),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"corrected_intent" varchar(64),
	"reviewer_notes" text,
	"reviewed_by" varchar(128),
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispute_outcome_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"dispute_id" varchar(64) NOT NULL,
	"order_id" varchar(64),
	"escrow_tx_id" varchar(64),
	"raised_by" varchar(16),
	"reason" varchar(64),
	"resolution" varchar(40),
	"outcome" varchar(24),
	"escrow_amount_cents" bigint,
	"refund_amount_cents" bigint,
	"days_to_resolve" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lakehouse_export_watermarks" (
	"table_name" varchar(64) PRIMARY KEY NOT NULL,
	"watermark" timestamp NOT NULL,
	"rows_exported" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_misses_tenant_status_idx" ON "intent_misses" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_misses_created_idx" ON "intent_misses" USING btree ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dispute_outcome_features_dispute_uniq" ON "dispute_outcome_features" USING btree ("dispute_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_outcome_features_tenant_idx" ON "dispute_outcome_features" USING btree ("tenant_id");
