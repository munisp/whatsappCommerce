-- === W44 preorders-offers (Coder B): haggling / custom offers ===
-- ADDITIVE ONLY (hand-written; chained after 0138).
--
-- custom_offers: a buyer haggles in chat (BOTH channels — "I'll pay X for
-- Y"), the merchant decides from an approval card (WA interactive buttons /
-- TG inline keyboard, id grammar offer:accept|reject|counter:<id>), and an
-- accepted offer produces a priced checkout link with a price-override
-- snapshot on the order + audit trail. One OPEN offer (pending/countered)
-- per (tenant, customer, product) — the partial unique index is the DB
-- backstop. Price floor: products.minPriceCents (nullable) — when set, an
-- offer below the floor is refused; unset means any positive amount.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "minPriceCents" integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_id" varchar(64) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"variant_id" varchar(36),
	"qty" integer DEFAULT 1 NOT NULL,
	"offered_price_cents" integer NOT NULL,
	"counter_price_cents" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"order_id" varchar(36),
	"decided_by" varchar(64),
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_offers_tenant_status_idx" ON "custom_offers" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_offers_tenant_customer_idx" ON "custom_offers" USING btree ("tenant_id","customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_offers_open_uidx" ON "custom_offers" USING btree ("tenant_id","customer_id","product_id") WHERE "status" IN ('pending', 'countered');
