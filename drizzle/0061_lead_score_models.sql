-- W20: ML propensity-based lead scoring model registry.
-- lead_score_models: per-tenant trained logistic-regression weights
--   (weights_jsonb number[] aligned with feature_names string[]) plus
--   training metadata (trained_at, sample_count, logloss, version).
-- Consumed by server/services/mlLeadScoring.ts; tenants below the minimum
-- sample gate have no rows and scoring falls back to the rule-based score.
-- Additive only.
CREATE TABLE IF NOT EXISTS "lead_score_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"weights_jsonb" jsonb NOT NULL,
	"feature_names" jsonb NOT NULL,
	"trained_at" timestamp DEFAULT now() NOT NULL,
	"sample_count" integer NOT NULL,
	"logloss" real,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_score_models_tenant_idx" ON "lead_score_models" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_score_models_tenant_version_uniq" ON "lead_score_models" USING btree ("tenant_id","version");
