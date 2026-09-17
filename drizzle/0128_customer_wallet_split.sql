-- W41 (Coder B, UC-2/UC-3): customer wallet (store credit) + split payments.
-- ADDITIVE ONLY (hand-written, journaled after 0127; idx 0127 reserved for
-- Coder A, merger re-chains per SPEC_W41).
--
-- UC-2: customer_wallets holds per-tenant per-customer store credit in
-- integer kobo. balance_cents is NEVER negative — debits are claim-first
-- guarded UPDATEs (balance_cents >= amount) in server/services/customerWallet.ts.
-- customer_wallet_entries is the APPEND-ONLY ledger (service exposes no
-- mutation path); (ref_id, direction) is unique for exactly-once retries.
--
-- UC-3: split_payment_sessions co-funds ONE order across N participants
-- (payment link or wallet); the order confirms only when the claim-first
-- tally reaches target_cents; on timeout (default 48h) every contribution
-- is auto-refunded (wallet credit default, PSP reversal optional).
CREATE TABLE IF NOT EXISTS "customer_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_phone" varchar(32) NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_wallet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"wallet_id" uuid NOT NULL,
	"customer_phone" varchar(32) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"reason" varchar(32) NOT NULL,
	"ref_id" varchar(160) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "split_payment_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"target_cents" bigint NOT NULL,
	"funded_cents" bigint DEFAULT 0 NOT NULL,
	"participant_count" integer NOT NULL,
	"participants" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_wallets_tenant_phone_uniq" ON "customer_wallets" USING btree ("tenant_id","customer_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_wallets_tenant_idx" ON "customer_wallets" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_wallet_entries_ref_uniq" ON "customer_wallet_entries" USING btree ("ref_id","direction");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_wallet_entries_wallet_idx" ON "customer_wallet_entries" USING btree ("wallet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_wallet_entries_tenant_phone_idx" ON "customer_wallet_entries" USING btree ("tenant_id","customer_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "split_payment_sessions_order_idx" ON "split_payment_sessions" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "split_payment_sessions_status_idx" ON "split_payment_sessions" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "split_payment_sessions_tenant_idx" ON "split_payment_sessions" USING btree ("tenant_id");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_wallet_entries" ADD CONSTRAINT "customer_wallet_entries_wallet_id_customer_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."customer_wallets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Never-negative + append-only DB-level backstop: the claim-first guarded
-- UPDATEs are the primary guard; these constraints make a bug fail closed
-- instead of silently corrupting money.
DO $$ BEGIN
	ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_balance_nonnegative" CHECK ("balance_cents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_wallet_entries" ADD CONSTRAINT "customer_wallet_entries_amount_positive" CHECK ("amount_cents" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
