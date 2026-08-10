CREATE TABLE IF NOT EXISTS "onboarding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36),
	"channel" varchar(16) NOT NULL,
	"phone" varchar(30),
	"state" varchar(20) DEFAULT 'intake' NOT NULL,
	"transcript" jsonb DEFAULT '[]' NOT NULL,
	"proposals" jsonb DEFAULT '[]' NOT NULL,
	"intake" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_sessions_tenant_idx" ON "onboarding_sessions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_sessions_channel_phone_idx" ON "onboarding_sessions" USING btree ("channel","phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_sessions_state_idx" ON "onboarding_sessions" USING btree ("state");
