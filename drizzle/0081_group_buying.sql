-- W27: group buying data layer.
-- group_deals: merchant deal — bulk price unlocked at threshold_qty by
--   deadline. group_deal_participants: per-participant authorization/hold;
--   on threshold met by deadline all confirm, else refunds/voids via the
--   existing refund paths. ALL money INTEGER CENTS. Additive only.
CREATE TABLE IF NOT EXISTS "group_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"title" varchar(200) NOT NULL,
	"description" text,
	"unit_price_cents" integer NOT NULL,
	"retail_price_cents" integer,
	"threshold_qty" integer NOT NULL,
	"current_qty" integer DEFAULT 0 NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"deadline" timestamp NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_deal_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"deal_id" uuid NOT NULL,
	"customer_phone" varchar(32) NOT NULL,
	"quantity" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'held' NOT NULL,
	"payment_ref" varchar(128),
	"order_id" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_deal_participants_deal_phone_uniq" ON "group_deal_participants" ("deal_id","customer_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_deal_participants_deal_idx" ON "group_deal_participants" ("deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_deal_participants_tenant_idx" ON "group_deal_participants" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_deal_participants_phone_idx" ON "group_deal_participants" ("customer_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_deals_tenant_idx" ON "group_deals" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_deals_status_idx" ON "group_deals" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_deals_deadline_idx" ON "group_deals" ("deadline");
