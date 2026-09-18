-- W40 tenancy (TEN-3): one messaging identity maps to exactly one tenant.
-- ADDITIVE ONLY (hand-written, journaled after 0122).
--
-- Before W40, tenants."whatsappPhoneNumberId" had no uniqueness constraint:
-- any operator of tenant B could claim tenant A's WhatsApp phone number id
-- via tenant.updateWhatsAppConfig, and the webhook dispatcher resolved the
-- tenant with LIMIT 1 first-match — inbound messages (and the PII in them)
-- could be hijacked cross-tenant. The same class existed for the Telegram
-- bot username (stored in settings.telegram.botUsername since W37, guarded
-- only by an application-level scan).
--
-- Dedupe doctrine: the partial unique index only constrains rows where the
-- channel identity is SET (not-null), so legacy NULL rows are unaffected.
-- If production data already contains a duplicate claim, CREATE UNIQUE
-- INDEX fails loudly and the operator must first re-point the LOSER tenant
-- to its own phone number id (the winner is the tenant that owns the number
-- in the Meta Business Manager — verifiable via the WABA); never silently
-- keep both. Application-level CONFLICT pre-checks in tenant.ts give the
-- honest error before the index is ever hit.
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_wa_phone_number_id_uidx"
	ON "tenants" USING btree ("whatsappPhoneNumberId")
	WHERE "whatsappPhoneNumberId" IS NOT NULL;
--> statement-breakpoint
-- Telegram bot usernames are case-insensitive; the router pre-check compares
-- lowercased values, so the index is on the lowercased expression.
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_telegram_bot_username_uidx"
	ON "tenants" USING btree (lower(settings->'telegram'->>'botUsername'))
	WHERE settings->'telegram'->>'botUsername' IS NOT NULL;
