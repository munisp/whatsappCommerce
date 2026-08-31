-- W32 recurring-tiers (Coder B): recurring rules for vendor bills / ad-hoc payments.
-- A due rule creates a vendor_bill (capture_source='recurring') or an adhoc
-- scheduled_payment, auto-pays under auto_pay_under_cents (after the W31
-- approvals gate), and advances next_run_at IN THE SAME TRANSACTION as the
-- creation so a crash can never double-create a period. Idempotency anchor:
-- scheduled_payments.idempotency_key `recur:<ruleId>:<period>`.
CREATE TABLE IF NOT EXISTS "recurring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"recipient" jsonb,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"cadence" varchar(16) NOT NULL,
	"day_of_month" integer,
	"auto_pay_under_cents" bigint DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_rules_status_next_idx" ON "recurring_rules" USING btree ("status","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_rules_tenant_idx" ON "recurring_rules" USING btree ("tenant_id","status");
