-- W27 catalog-ai: AI-drafted product listings (voice-note / photo → draft → confirm → publish).
CREATE TABLE IF NOT EXISTS "catalog_ai_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"source" varchar(16) NOT NULL,
	"merchant_phone" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'pending_confirm' NOT NULL,
	"transcript" text,
	"media_id" varchar(128),
	"name" varchar(255),
	"description" text,
	"category" varchar(100),
	"suggested_price_cents" integer,
	"price_band_low_cents" integer,
	"price_band_high_cents" integer,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"product_id" varchar(36),
	"raw_extraction" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp,
	"published_at" timestamp
);
CREATE INDEX IF NOT EXISTS "catalog_ai_drafts_tenant_idx" ON "catalog_ai_drafts" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "catalog_ai_drafts_tenant_status_idx" ON "catalog_ai_drafts" USING btree ("tenant_id","status");
CREATE INDEX IF NOT EXISTS "catalog_ai_drafts_phone_idx" ON "catalog_ai_drafts" USING btree ("merchant_phone");
