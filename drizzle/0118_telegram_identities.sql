-- W37 telegram (Coder B): telegram_identities.
-- ADDITIVE ONLY. Binds a Telegram chat_id to a canonical customer identity
-- per tenant. Phone linkage happens ONLY via an explicit Telegram
-- contact-share (request_contact keyboard) where contact.user_id == from.id
-- — never inferred. Session key for Telegram conversations is
-- `telegram:<chat_id>` (see server/services/channelIdentity.ts).
CREATE TABLE IF NOT EXISTS "telegram_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"chat_id" varchar(40) NOT NULL,
	"phone_e164" varchar(30),
	"username" text,
	"linked_via" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_identities_tenant_chat_uniq" ON "telegram_identities" USING btree ("tenant_id","chat_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_identities_tenant_phone_idx" ON "telegram_identities" USING btree ("tenant_id","phone_e164");
--> statement-breakpoint
-- Telegram session keys (`telegram:<chat_id>`, chat ids can be negative and
-- up to ~13 digits) exceed the legacy 20-char phone column; widen it so NLP
-- sessions can key on telegram identities. Additive (widening only).
ALTER TABLE "nlp_sessions" ALTER COLUMN "waPhoneNumber" TYPE varchar(40);
