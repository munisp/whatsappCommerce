-- === W47 merchant ===
-- ONB-M-18: idempotency ledger for the abandoned-onboarding sweep — one
-- row per (tenant, kind) so the 7d re-engagement nudge and the 45d churn
-- each fire at most once per tenant, insert-first claim.
CREATE TABLE IF NOT EXISTS "onboarding_reengagement_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_reengagement_tenant_kind_uq" ON "onboarding_reengagement_log" USING btree ("tenant_id","kind");
