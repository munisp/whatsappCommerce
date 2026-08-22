-- W27 bookkeeping: opt-in scheduled sales digests (daily/weekly) delivered
-- via WhatsApp. Prefs per (tenant, phone); log enforces idempotent sends per
-- (tenant, phone, period_key). ALL money is INTEGER CENTS. Additive only.
CREATE TABLE IF NOT EXISTS "bookkeeping_digest_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"frequency" varchar(8) DEFAULT 'weekly' NOT NULL,
	"opted_in" boolean DEFAULT true NOT NULL,
	"hour_utc" integer DEFAULT 7 NOT NULL,
	"last_sent_period_key" varchar(16),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookkeeping_digest_prefs_tenant_phone_idx" ON "bookkeeping_digest_prefs" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookkeeping_digest_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"frequency" varchar(8) NOT NULL,
	"period_key" varchar(16) NOT NULL,
	"sales_cents" integer DEFAULT 0 NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookkeeping_digest_log_tenant_period_idx" ON "bookkeeping_digest_log" USING btree ("tenant_id","phone","period_key");