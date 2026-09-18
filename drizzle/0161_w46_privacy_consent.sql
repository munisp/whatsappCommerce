-- === W46 privacy-consent (Coder B): TEN-15/16/17/18/19/20/22 ===
-- ADDITIVE ONLY (hand-written; chained after 0151).
--
-- TEN-15: products age gate columns + age_attestations evidence table.
-- TEN-16: consents proof-of-consent versioning + re-grant abuse counters.
-- TEN-17: payment_disputes cross-tenant respondent routing column.
-- TEN-18: supplier_tax_profile_versions (versioned/effective-dated identity).
-- TEN-19: tenant_invite_tokens.bound_phone (verified-identity redemption).
-- TEN-20: auth_known_devices (new-device second factor).
-- TEN-22: kyc_applications KYB review-queue SLA timestamps.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ageRestricted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "minAge" integer;
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "policy_version" varchar(40);
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "proof_template" varchar(80);
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "proof_wamid" varchar(80);
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "regrant_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN IF NOT EXISTS "last_regrant_at" timestamp;
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "slaDueAt" timestamp;
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "escalatedAt" timestamp;
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "slaBreachedAt" timestamp;
--> statement-breakpoint
ALTER TABLE "tenant_invite_tokens" ADD COLUMN IF NOT EXISTS "bound_phone" varchar(30);
--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD COLUMN IF NOT EXISTS "respondent_tenant_id" varchar(36);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "age_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(60) NOT NULL,
	"attested_age" integer NOT NULL,
	"channel" varchar(16) DEFAULT 'whatsapp' NOT NULL,
	"source" varchar(32) DEFAULT 'chat_reply' NOT NULL,
	"order_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "age_attestations_tenant_phone_uq" ON "age_attestations" USING btree ("tenant_id","phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "age_attestations_tenant_idx" ON "age_attestations" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_known_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"device_hash" varchar(128) NOT NULL,
	"label" varchar(120),
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_known_devices_user_device_uq" ON "auth_known_devices" USING btree ("user_id","device_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_known_devices_user_idx" ON "auth_known_devices" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_tax_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"supplier_key" varchar(128) NOT NULL,
	"supplier_tenant_id" varchar(36),
	"vendor_ref" varchar(128),
	"vendor_name" varchar(160) NOT NULL,
	"tax_id" varchar(64),
	"tax_id_type" varchar(16),
	"country_code" char(2),
	"withholding_bps" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" varchar(120),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_tax_profile_versions_uq" ON "supplier_tax_profile_versions" USING btree ("tenant_id","supplier_key","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_tax_profile_versions_key_idx" ON "supplier_tax_profile_versions" USING btree ("tenant_id","supplier_key","effective_from");
