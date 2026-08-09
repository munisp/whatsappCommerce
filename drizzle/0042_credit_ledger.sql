CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"po_id" varchar(36),
	"due_date" timestamp,
	"status" varchar(20) DEFAULT 'posted' NOT NULL,
	"ref" varchar(128),
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_account_idx" ON "credit_ledger" USING btree ("credit_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_due_idx" ON "credit_ledger" USING btree ("due_date");
