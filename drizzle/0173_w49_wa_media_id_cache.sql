-- === W49 RICHMEDIA (RICH-11): Meta /media upload cache table.
-- Additive-only; IF NOT EXISTS for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "wa_media_id_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"imageUrl" text NOT NULL,
	"mediaId" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wa_media_id_cache_tenant_url_uq" ON "wa_media_id_cache" ("tenantId", "imageUrl");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_media_id_cache_expiry_idx" ON "wa_media_id_cache" ("expiresAt");
