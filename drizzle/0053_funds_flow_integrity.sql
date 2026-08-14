-- R2 funds-flow integrity hardening (assurance audit A1-02/A1-03/A1-04).
-- All statements additive + idempotent (IF NOT EXISTS).

-- A1-04 / F-01: exactly-once invoice draw per (account, ref). Backstop for
-- the PO double-approval race: approvePurchaseOrder is now claim-first on
-- purchase_orders.status, and a concurrent/crash-retry draw with the same
-- ref (`draw:{poId}`) fails 23505 here and is translated by drawOnCreditTx
-- into an idempotent already-drawn success returning the existing row.
-- Partial on kind='invoice_draw' for parity with 0052's repayment index.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_draw_ref_uniq" ON "credit_ledger" USING btree ("credit_account_id","ref") WHERE kind = 'invoice_draw' AND ref IS NOT NULL;
--> statement-breakpoint
-- A1-03: exactly-once withdrawal per (wallet, reference). The client
-- reference is requestWithdrawal's idempotency key; the previous
-- read-then-check ran OUTSIDE the debit transaction, so two concurrent
-- same-reference withdrawals both debited. The loser now hits 23505 on
-- insert and is translated into an idempotent replay (duplicate: true) of
-- the original pending withdrawal.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_tx_wallet_ref_uniq" ON "wallet_transactions" USING btree ("wallet_id","reference") WHERE reference IS NOT NULL;
--> statement-breakpoint
-- A1-02 / F-03: durable ledger of repayment-at-source mandate charges.
-- 'pending' provider charges are no longer settled immediately; they are
-- persisted here and reconciled via the provider's fetchStatus() by
-- reconcilePendingMandateCharges() (never a blind re-charge).
CREATE TABLE IF NOT EXISTS "mandate_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mandate_id" uuid,
	"mandate_ref" varchar(128),
	"provider" varchar(30) NOT NULL,
	"reference" varchar(128) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"provider_status" varchar(40),
	"raw_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mandate_charges" ADD CONSTRAINT "mandate_charges_account_id_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mandate_charges_reference_uniq" ON "mandate_charges" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mandate_charges_account_idx" ON "mandate_charges" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mandate_charges_status_idx" ON "mandate_charges" USING btree ("status");
