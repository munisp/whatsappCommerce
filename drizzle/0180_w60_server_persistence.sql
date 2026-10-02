-- === W60 server-persistence: durable replacements for the last
-- business-data in-memory stores (audit W60-A CRITICAL #1/#2).
--   pending_cico_intents — two-step CICO confirm intents (was bankingChat.ts
--     pendingCico Map). Atomic exactly-once claim via
--     DELETE ... WHERE key=$1 AND "expiresAt" > now() RETURNING *.
--   medusa_promo_outbox — durable retry queue for Medusa promo pushes (was
--     medusaPromoSync.ts pendingQueue array); swept by
--     /api/scheduled/medusa-promo-outbox with bounded retry/backoff.
-- Additive-only; IF NOT EXISTS everywhere for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "pending_cico_intents" (
	"key" text PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"agentIdentity" varchar(64),
	"kind" varchar(16) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"amountCents" integer NOT NULL,
	"payload" jsonb,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_cico_intents_expiry_idx" ON "pending_cico_intents" ("expiresAt");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "medusa_promo_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"promoCode" varchar(64) NOT NULL,
	"op" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medusa_promo_outbox_dedupe_uniq" ON "medusa_promo_outbox" ("tenantId", "promoCode", "op");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medusa_promo_outbox_status_idx" ON "medusa_promo_outbox" ("status", "updatedAt");
