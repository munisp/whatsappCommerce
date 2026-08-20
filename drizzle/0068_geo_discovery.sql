-- W25: geospatial merchant discovery data layer.
-- merchant_locations: per-branch geo data for merchant discovery
--   (server/services/geoDiscovery.ts). geohash is a base32 precision-5 cell
--   prefilter; exact distance filtering is haversine at query time.
-- sponsored_listings: location-aware paid placement. ALL money columns are
--   INTEGER CENTS. status is 'draft' | 'active' | 'paused' | 'exhausted'.
-- Additive only.
CREATE TABLE IF NOT EXISTS "merchant_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"label" varchar(120) DEFAULT 'Main branch' NOT NULL,
	"latitude" numeric(10, 7) NOT NULL,
	"longitude" numeric(10, 7) NOT NULL,
	"address_line" varchar(255),
	"city" varchar(120),
	"country" varchar(120),
	"service_radius_km" numeric(8, 3) DEFAULT 5 NOT NULL,
	"delivery_zones" jsonb,
	"discoverable" boolean DEFAULT false NOT NULL,
	"open_hours" jsonb,
	"geohash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsored_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(160) NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"center_lat" numeric(10, 7) NOT NULL,
	"center_lng" numeric(10, 7) NOT NULL,
	"radius_km" numeric(8, 3) DEFAULT 10 NOT NULL,
	"daily_budget_cents" integer NOT NULL,
	"spent_today_cents" integer DEFAULT 0 NOT NULL,
	"bid_cents" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_locations_tenant_idx" ON "merchant_locations" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_locations_geohash_idx" ON "merchant_locations" USING btree ("geohash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsored_listings_tenant_idx" ON "sponsored_listings" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsored_listings_status_idx" ON "sponsored_listings" USING btree ("status");
