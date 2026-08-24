-- W30 (Coder A / loans-credit): micro-loan funding leg (verify-v1 #12).
-- Every disbursement must be backed by a lender wholesale facility:
-- acceptLoanTx atomically decrements credit_facilities.commitment_cents and
-- records the funding leg (facility + principal + deterministic TigerBeetle
-- idempotency reference `loanfund:<loanId>`) here, in the same transaction
-- as the wallet credit. One funding row per loan.
CREATE TABLE IF NOT EXISTS "merchant_loan_funding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL REFERENCES "merchant_loans"("id"),
	"tenant_id" varchar(36) NOT NULL,
	"facility_id" uuid NOT NULL REFERENCES "credit_facilities"("id"),
	"principal_cents" integer NOT NULL,
	"ledger_ref" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_loan_funding_loan_uniq" ON "merchant_loan_funding" USING btree ("loan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_loan_funding_facility_idx" ON "merchant_loan_funding" USING btree ("facility_id");
