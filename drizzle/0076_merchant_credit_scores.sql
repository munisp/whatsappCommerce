-- W27 credit: cached deterministic merchant credit-score snapshots.
-- Computed on demand by server/services/creditScore.ts (getMerchantScore);
-- additive only. Score is an integer 0-1000; factors jsonb documents the
-- per-factor point contributions for auditability/portability.
CREATE TABLE IF NOT EXISTS "merchant_credit_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"score" integer NOT NULL,
	"factors" jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_credit_scores_tenant_merchant_uniq" ON "merchant_credit_scores" ("tenant_id","merchant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_credit_scores_tenant_idx" ON "merchant_credit_scores" ("tenant_id");
