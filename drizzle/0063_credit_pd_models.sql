-- W21: ML probability-of-default (PD) credit model registry.
-- credit_pd_models: trained logistic-regression PD model weights
--   (weights_jsonb number[] aligned with feature_names string[]) plus
--   training metadata (trained_at, sample_count, logloss, auc, version).
-- tenant_id is NULLABLE: a null-tenant row is the GLOBAL corpus model used
-- as fallback when a tenant's own book is below the minimum-sample gate.
-- Consumed by server/services/tradeCredit/mlPdScoring.ts; scopes below the
-- gate have no rows and PD scoring falls back to the rule-score proxy.
-- Additive only.
CREATE TABLE IF NOT EXISTS "credit_pd_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36),
	"weights_jsonb" jsonb NOT NULL,
	"feature_names" jsonb NOT NULL,
	"trained_at" timestamp DEFAULT now() NOT NULL,
	"sample_count" integer NOT NULL,
	"logloss" real,
	"auc" real,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_pd_models_tenant_idx" ON "credit_pd_models" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_pd_models_tenant_version_uniq" ON "credit_pd_models" USING btree ("tenant_id","version");
