-- Platform-wide driver pool (hand-written; chained after 0170 — drizzle-kit's auto-diff journal has
-- pre-existing "snapshot data is malformed" collisions unrelated to this change, so this migration was
-- written by hand against the current schema, matching this repo's established convention for that
-- situation, e.g. 0167_w47_stakeholders.sql).
--
-- Retires the per-tenant ONB-S-10 "riders" table (2026-09-26, user's explicit direction): confirmed
-- both "riders" and "deliveries" were genuinely empty (0 rows) on the live DB before writing this —
-- no data migration needed, a straight drop + rename is safe.
DROP TABLE IF EXISTS "riders";
--> statement-breakpoint
CREATE TYPE "public"."driver_status" AS ENUM('pending_verification', 'offline', 'online', 'suspended');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified_at" timestamp,
	"status" "driver_status" DEFAULT 'pending_verification' NOT NULL,
	"vehicle_type" varchar(30),
	"current_lat" numeric(10, 7),
	"current_lng" numeric(10, 7),
	"last_location_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drivers_email_uq" ON "drivers" USING btree ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drivers_status_idx" ON "drivers" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_email_otp_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"otp_hash" varchar(128) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"purpose" varchar(16) DEFAULT 'login' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_email_otp_email_purpose_uq" ON "driver_email_otp_sessions" USING btree ("email","purpose");
--> statement-breakpoint
ALTER TABLE "deliveries" RENAME COLUMN "rider_id" TO "driver_id";
