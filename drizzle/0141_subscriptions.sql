-- === W44 deposits-subs-digital (Coder C): subscription auto-billing ===
-- ADDITIVE ONLY (hand-written; chained after 0140).
--
-- subscription_plans: merchant-defined recurring plans bound to a product
-- (interval day|week|month, priceCents integer kobo).
-- customer_subscriptions: a buyer's subscription to a plan. The billing
-- tick (/api/scheduled/subscription-billing, cron-scoped JWT per W42
-- cronAuth) claims due rows FOR UPDATE, charges the saved W41 token via
-- customerPaymentTokens.chargeCustomerToken, and on success creates the
-- order + advances next_billing_at in the SAME transaction. Every charge is
-- idempotent on reference sub_billing:<subId>:<period>; after 3 failed
-- attempts the subscription flips to past_due and stays there (dunning
-- notice on every failure, both channels).
CREATE TABLE IF NOT EXISTS "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"name" varchar(160) NOT NULL,
	"interval" varchar(8) NOT NULL,
	"price_cents" integer NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_interval_ck" CHECK ("interval" IN ('day','week','month'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_tenant_idx" ON "subscription_plans" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"plan_id" uuid NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"next_billing_at" timestamp NOT NULL,
	"payment_token_id" uuid,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_billed_period" varchar(32),
	"last_charge_ref" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_subs_tenant_status_due_idx" ON "customer_subscriptions" USING btree ("tenant_id","status","next_billing_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_subs_tenant_customer_idx" ON "customer_subscriptions" USING btree ("tenant_id","customer_id");
--> statement-breakpoint
-- One live subscription per (tenant, plan, customer) — cancelled rows are
-- historical and excluded so a re-subscribe is a fresh row.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_subs_live_uidx" ON "customer_subscriptions" USING btree ("tenant_id","plan_id","customer_id") WHERE "status" <> 'cancelled';
