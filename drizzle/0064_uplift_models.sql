-- W21: uplift-modeled broadcast targeting model registry.
-- uplift_models: per-tenant, per-role ('treatment' | 'control') trained
--   logistic-regression weights (weights_jsonb number[] aligned with
--   feature_names string[]) plus training metadata (trained_at,
--   sample_count, logloss, version). The treatment arm is learned from
--   customers who received a prior broadcast/win-back message; the control
--   arm from comparable non-messaged customers. scoreUplift returns
--   pTreatment − pControl.
-- Consumed by server/services/mlUplift.ts; tenants below the per-arm
-- minimum-sample gate have no rows and broadcast targeting falls back to
-- the rule-based segment heuristic. Additive only.
CREATE TABLE IF NOT EXISTS "uplift_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"role" varchar(16) NOT NULL,
	"weights_jsonb" jsonb NOT NULL,
	"feature_names" jsonb NOT NULL,
	"trained_at" timestamp DEFAULT now() NOT NULL,
	"sample_count" integer NOT NULL,
	"logloss" real,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uplift_models_tenant_idx" ON "uplift_models" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uplift_models_tenant_role_version_uniq" ON "uplift_models" USING btree ("tenant_id","role","version");
