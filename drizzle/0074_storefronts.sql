-- W27 C: public shareable storefronts (server/services/storefront.ts).
-- storefronts: one public web storefront per tenant at /shop/:slug. slug is
-- globally unique; isVisible gates public access; showLocation gates location
-- publication (additionally requires approved KYB at render time).
-- Additive only.
CREATE TABLE IF NOT EXISTS "storefronts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"hero_text" varchar(280),
	"theme_color" varchar(16) DEFAULT '#075E54' NOT NULL,
	"is_visible" boolean DEFAULT false NOT NULL,
	"show_location" boolean DEFAULT false NOT NULL,
	"default_locale" varchar(8) DEFAULT 'en' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storefronts_tenant_uidx" ON "storefronts" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storefronts_slug_uidx" ON "storefronts" USING btree ("slug");
