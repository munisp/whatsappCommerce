-- W30 (Coder D): step-up OTP challenges for money-path kill chain (V2#2).
-- Additive only. A fresh OTP to the tenant admin phone is required for
-- payout-destination changes, withdrawals above threshold, owner role grants
-- and payment admin overrides. Single-use, short-lived, attempt-capped.
CREATE TABLE IF NOT EXISTS "step_up_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"purpose" varchar(40) NOT NULL,
	"otp_hash" varchar(160) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_up_challenges_tenant_purpose_idx" ON "step_up_challenges" USING btree ("tenant_id","purpose","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_up_challenges_user_idx" ON "step_up_challenges" USING btree ("user_id","created_at");
