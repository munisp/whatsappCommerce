-- W14: credit-bureau reporting for the trade-credit book (roadmap F3).
-- credit_accounts: bureau-consent capture + link to a credit_facilities row.
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "bureau_consent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "bureau_consent_ref" varchar(64);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "facility_id" varchar(36);
--> statement-breakpoint
-- bureau_report_log: one row per attempted bureau report (event sourcing for
-- the outbox — 'pending' rows are retryable via retryFailedReports()).
CREATE TABLE IF NOT EXISTS "bureau_report_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" varchar(36) NOT NULL,
	"event_type" varchar(30) NOT NULL,
	"bureau" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_report_log_account_idx" ON "bureau_report_log" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_report_log_status_idx" ON "bureau_report_log" USING btree ("status");
--> statement-breakpoint
-- credit_facilities: lender-side wholesale facilities funding the trade-credit
-- book (W14-C2 consumes this shape — keep column names/types EXACTLY).
CREATE TABLE IF NOT EXISTS "credit_facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lender_name" varchar(255) NOT NULL,
	"facility_ref" varchar(64) NOT NULL,
	"commitment_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"advance_rate_bps" integer DEFAULT 8000 NOT NULL,
	"covenants" jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_facilities_ref_uniq" ON "credit_facilities" USING btree ("facility_ref");
