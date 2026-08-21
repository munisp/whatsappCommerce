-- W27 C: multi-language framework (server/services/i18n.ts).
-- tenant_i18n_overrides: per-tenant custom translations for message-catalog
-- keys. Lookup order at render time: tenant override → locale pack → en.
-- Durable per-customer locale already lives in customers.language; the
-- per-tenant default lives in tenants.settings.locale /
-- tenants."defaultLanguage" — no new columns needed there. Additive only.
CREATE TABLE IF NOT EXISTS "tenant_i18n_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"locale" varchar(8) NOT NULL,
	"key" varchar(64) NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_i18n_overrides_tenant_locale_key_uidx" ON "tenant_i18n_overrides" USING btree ("tenant_id", "locale", "key");
