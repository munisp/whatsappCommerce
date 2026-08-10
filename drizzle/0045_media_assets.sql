CREATE TABLE IF NOT EXISTS "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"mime" varchar(64) NOT NULL,
	"data_uri" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_tenant_idx" ON "media_assets" USING btree ("tenant_id");
