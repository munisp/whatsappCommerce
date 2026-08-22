-- W27: B2B wholesale marketplace data layer.
-- wholesale_listings: wholesaler-published bulk listings (MOQ, status).
-- wholesale_listing_tiers: tiered unit pricing bands, INTEGER CENTS.
-- wholesale_orders: retailer purchase orders; trade-credit checkout draws on
--   the existing credit account (server/services/tradeCredit) gated by the
--   platform merchant credit score. Additive only.
CREATE TABLE IF NOT EXISTS "wholesale_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"title" varchar(200) NOT NULL,
	"description" text,
	"category" varchar(120),
	"moq" integer DEFAULT 1 NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wholesale_listing_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"listing_id" uuid NOT NULL,
	"min_qty" integer NOT NULL,
	"max_qty" integer,
	"unit_price_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wholesale_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"buyer_tenant_id" varchar(36),
	"buyer_phone" varchar(32),
	"listing_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"payment_mode" varchar(16) DEFAULT 'pay_now' NOT NULL,
	"credit_ledger_id" varchar(64),
	"credit_score" integer,
	"order_id" varchar(64),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_listings_tenant_idx" ON "wholesale_listings" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_listings_status_idx" ON "wholesale_listings" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_listings_category_idx" ON "wholesale_listings" ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_listing_tiers_listing_idx" ON "wholesale_listing_tiers" ("listing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_listing_tiers_tenant_idx" ON "wholesale_listing_tiers" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_orders_tenant_idx" ON "wholesale_orders" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_orders_buyer_idx" ON "wholesale_orders" ("buyer_tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_orders_listing_idx" ON "wholesale_orders" ("listing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_orders_status_idx" ON "wholesale_orders" ("tenant_id","status");
