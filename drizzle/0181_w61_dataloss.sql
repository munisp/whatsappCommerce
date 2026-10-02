-- === W61 dataloss: raw PSP webhook landing pad (audit W61 HIGH #5).
-- The Paystack-family webhook routes ack 200 first (W48); this table persists
-- the raw, HMAC-verified payload BEFORE the ack so a crash between ack and
-- the async confirm chain is recoverable. Additive-only; IF NOT EXISTS
-- everywhere for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "raw_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"event_type" varchar(64),
	"reference" varchar(128),
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_webhook_events_provider_idx" ON "raw_webhook_events" ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_webhook_events_reference_idx" ON "raw_webhook_events" ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_webhook_events_processed_idx" ON "raw_webhook_events" ("processed");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_webhook_events_received_idx" ON "raw_webhook_events" ("received_at");
