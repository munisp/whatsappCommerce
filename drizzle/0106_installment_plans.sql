-- W32 pay-over-time (Coder A): installment plans for pay-over-time vendor
-- bill pay. A plan links a vendor bill (paid IN FULL at origination from the
-- platform lending facility, microLoans-style funding leg) to a merchant_loans
-- loan; repayment runs as N installments captured via the existing mandate
-- rails. `schedule` is a JSONB array of
-- {seq, dueAt, amountCents, principalCents, feeCents, status, paidAt} —
-- integer cents throughout, statuses due|paid|overdue.
-- Config rides the platform escrow_config singleton (additive columns):
-- minimum credit score, flat fee in basis points of principal, and the
-- documented early-settle fee policy switch (prorate vs full fee).
CREATE TABLE IF NOT EXISTS "installment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"principal_cents" bigint NOT NULL,
	"installments" integer NOT NULL,
	"fee_bps" integer NOT NULL,
	"per_installment_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"loan_id" uuid,
	"schedule" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "installment_plans_tenant_status_idx" ON "installment_plans" USING btree ("tenant_id","status");
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "pay_over_time_min_score" integer DEFAULT 600 NOT NULL;
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "pay_over_time_fee_bps" integer DEFAULT 250 NOT NULL;
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "pay_over_time_prorate_early_fee" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
