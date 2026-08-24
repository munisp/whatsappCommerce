-- W30 (Coder C): sponsored spend writer (V2#16).
-- spent_today_cents previously had NO writer so the daily budget cap never
-- tripped. `spent_on_date` makes the counter self-resetting (lazy daily
-- reset at serve/read time — deterministic, no cron dependency) and
-- sponsored_spend_events is the honest per-serve billing ledger.
ALTER TABLE "sponsored_listings" ADD COLUMN IF NOT EXISTS "spent_on_date" varchar(10);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsored_spend_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"spend_date" varchar(10) NOT NULL,
	"kind" varchar(16) DEFAULT 'serve' NOT NULL,
	"amount_cents" integer NOT NULL,
	"reference" varchar(160) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sponsored_spend_reference_uniq" ON "sponsored_spend_events" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsored_spend_listing_idx" ON "sponsored_spend_events" USING btree ("listing_id","spend_date");
