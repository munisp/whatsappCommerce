-- W38 (Coder B, PAY-4/5/6): pot_charges — durable ledger of every
-- pay-over-time mandate charge (installment `potcap:` + early-settle
-- `potsettle:`). Pre-W38 these charges were persisted nowhere, so a
-- 'pending' provider charge could never be reconciled (money collected,
-- loan outstanding forever) and an early-settle was permanently stuck
-- behind its exactly-once claim. The payOverTime.reconcilePendingPotCharges
-- sweep converges pending rows via the provider's READ-ONLY fetchStatus()
-- and settles exactly once (merchant_loan_repayments reference unique index
-- backstop); 'settlement_failed' rows are the durable retry marker for
-- charge-succeeded/settle-refused gaps.
-- ADDITIVE ONLY.
CREATE TABLE IF NOT EXISTS "pot_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"plan_id" uuid NOT NULL,
	"loan_id" uuid,
	"mandate_id" uuid,
	"provider" varchar(30) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"seq" integer,
	"reference" varchar(160) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"provider_status" varchar(40),
	"raw_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pot_charges_reference_uniq" ON "pot_charges" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pot_charges_plan_idx" ON "pot_charges" USING btree ("plan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pot_charges_status_idx" ON "pot_charges" USING btree ("status");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "pot_charges" ADD CONSTRAINT "pot_charges_plan_id_installment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."installment_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
