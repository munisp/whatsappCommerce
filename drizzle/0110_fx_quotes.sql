-- W32 earlypay-fx (Coder C): cross-border FX vendor payout quotes.
-- Lifecycle: quoted -> accepted (guarded single consume within expiry)
-- -> executed (wallet debited in from_currency + delivered via the Mojaloop
-- rail) | expired | failed. provider_ref is UNIQUE so a replayed quote
-- request can never mint two quotes at the provider. Fee math is integer
-- cents: fee_cents + net_cents == amount_cents (net = amount - fee is what
-- converts at `rate`); total_cents is the gross from_currency debit.
CREATE TABLE IF NOT EXISTS "fx_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"rate" numeric(20,8) NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_ref" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'quoted' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"payout_ref" varchar(128),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fx_quotes_provider_ref_uniq" ON "fx_quotes" USING btree ("provider_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fx_quotes_tenant_status_idx" ON "fx_quotes" USING btree ("tenant_id","status");
