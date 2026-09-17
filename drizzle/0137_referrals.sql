-- === W44 giftcards-referrals (Coder A): referrals ===
-- ADDITIVE ONLY (hand-written; chained after 0136).
--
-- tenants.referralRewardCents (integer kobo, default 0 = OFF): the wallet
-- credit the referrer earns when a referee's first order is PAID.
-- referral_codes: one shareable code per customer (unique per tenant).
-- referral_events: attribution → rewarded|voided rail. ONE attribution per
-- referee (partial unique index on referee, non-voided). Reward moves money
-- claim-first via customerWallet.creditWallet (refId referral:<eventId>).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "referralRewardCents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_id" varchar(64) NOT NULL,
	"code" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_tenant_code_uidx" ON "referral_codes" USING btree ("tenant_id","code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_codes_tenant_customer_idx" ON "referral_codes" USING btree ("tenant_id","customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"code_id" uuid NOT NULL,
	"referee_customer_id" varchar(64) NOT NULL,
	"order_id" varchar(64),
	"status" varchar(16) DEFAULT 'attributed' NOT NULL,
	"reward_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_events_referee_uidx" ON "referral_events" USING btree ("tenant_id","referee_customer_id") WHERE "status" <> 'voided';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_events_tenant_status_idx" ON "referral_events" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_events_order_idx" ON "referral_events" USING btree ("order_id");
