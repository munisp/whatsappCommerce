-- W27 credit: micro-loans (working capital), repayment ledger, portable
-- credit certificates, and wallet-tx enum values for loan money movement.
-- All money columns are INTEGER CENTS. Additive only.
ALTER TYPE "wallet_tx_type" ADD VALUE IF NOT EXISTS 'loan_disbursement';
--> statement-breakpoint
ALTER TYPE "wallet_tx_type" ADD VALUE IF NOT EXISTS 'loan_repayment';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"principal_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"outstanding_cents" integer NOT NULL,
	"repayment_pct" integer NOT NULL,
	"score_at_accept" integer NOT NULL,
	"tier" varchar(8) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"wallet_tx_id" varchar(36),
	"disbursed_at" timestamp,
	"due_at" timestamp,
	"repaid_at" timestamp,
	"defaulted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_loans_tenant_idx" ON "merchant_loans" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_loans_merchant_idx" ON "merchant_loans" ("tenant_id","merchant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_loans_status_idx" ON "merchant_loans" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_loan_repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL REFERENCES "merchant_loans"("id"),
	"tenant_id" varchar(36) NOT NULL,
	"amount_cents" integer NOT NULL,
	"source" varchar(24) NOT NULL,
	"order_id" varchar(36),
	"wallet_tx_id" varchar(36),
	"reference" varchar(160) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_loan_repayments_ref_uniq" ON "merchant_loan_repayments" ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_loan_repayments_loan_idx" ON "merchant_loan_repayments" ("loan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_loan_repayments_tenant_idx" ON "merchant_loan_repayments" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_credit_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" varchar(128) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_credit_cert_tenant_idx" ON "merchant_credit_certificates" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_credit_cert_merchant_idx" ON "merchant_credit_certificates" ("tenant_id","merchant_id");
