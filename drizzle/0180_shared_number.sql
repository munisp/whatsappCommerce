-- Shared platform WhatsApp number: one number for every shop that has no number of its own. A buyer reaches a
-- shop by sending its code ("SHOP ADIRE", usually from a wa.me link with the text prefilled); the shop they
-- last reached is remembered per buyer. Hand-written (same convention as 0179); every statement is safe to re-run.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "shopCode" varchar(32);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_shop_code_lower_uq" ON "tenants" (lower("shopCode")) WHERE "shopCode" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shared_number_visits" (
	"buyerPhone" varchar(32) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"firstVisitAt" timestamp DEFAULT now() NOT NULL,
	"lastActiveAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shared_number_visits_pk" PRIMARY KEY ("buyerPhone", "tenantId")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_number_visits_buyer_active_idx" ON "shared_number_visits" USING btree ("buyerPhone", "lastActiveAt");
