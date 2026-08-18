-- W22: contextual-bandit credit-limit decision log.
-- bandit_decisions: one row per limit suggestion the bandit scored —
-- the normalized context vector (context_jsonb number[], aligned with
-- server/services/banditLimits.ts BANDIT_FEATURE_NAMES), the multiplier
-- the LinUCB policy chose, the baseline rule-based limit, the limit the
-- bandit would apply (clamped by program caps), the mode ('shadow' |
-- 'active') and the realized reward (1 on-time, 0.5 late-cured,
-- 0 default; NULL until the runBanditRewardTick cron resolves it).
-- Consumed by server/services/banditLimits.ts; in shadow mode (the
-- default) rows are observability only and the applied limit is the
-- rule-based baseline. Additive only.
CREATE TABLE IF NOT EXISTS "bandit_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"buyer_id" varchar(36) NOT NULL,
	"context_jsonb" jsonb NOT NULL,
	"chosen_multiplier" real NOT NULL,
	"suggested_limit_cents" bigint NOT NULL,
	"baseline_limit_cents" bigint NOT NULL,
	"mode" varchar(16) DEFAULT 'shadow' NOT NULL,
	"reward" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bandit_decisions_tenant_idx" ON "bandit_decisions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bandit_decisions_reward_idx" ON "bandit_decisions" USING btree ("reward");
