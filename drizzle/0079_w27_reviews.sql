-- W27 (Coder E): purchase-verified reviews.
-- A review may be created only when the reviewer holds a completed/delivered
-- order for the merchant (enforced in server/services/reviews.ts). One review
-- per (tenant_id, order_id, product_id); product_id '' = merchant-level.
-- rating is 1..5. status: published | flagged | removed.
-- Additive only.
CREATE TABLE IF NOT EXISTS "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"product_id" varchar(36) DEFAULT '' NOT NULL,
	"customer_phone" varchar(30) NOT NULL,
	"rating" integer NOT NULL,
	"text" text,
	"status" varchar(16) DEFAULT 'published' NOT NULL,
	"merchant_response" text,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_order_product_idx" ON "reviews" ("tenant_id","order_id","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_tenant_idx" ON "reviews" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_product_idx" ON "reviews" ("tenant_id","product_id");
