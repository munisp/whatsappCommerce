-- W37 telegram (Coder A): telegram_outbox.
-- ADDITIVE ONLY. Telegram outbound delivery ledger + retry/DLQ — the
-- telegram analogue of whatsapp_notification_log (which is phone/wamid-keyed
-- with no channel column, so a separate table is the honest choice; see
-- SPEC_W37 Coder A §2). One row per outbound message; failed rows are
-- replayed verbatim from `payload` by runTelegramSendRetries with the same
-- 1m/5m/15m/1h classified backoff as waSender. status:
-- pending | sent | failed | dead | simulated.
CREATE TABLE IF NOT EXISTS "telegram_outbox" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"chat_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"payload" jsonb,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp,
	"last_error" text,
	"telegram_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_outbox_tenant_idx" ON "telegram_outbox" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_outbox_chat_idx" ON "telegram_outbox" USING btree ("chat_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_outbox_retry_idx" ON "telegram_outbox" USING btree ("next_retry_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_outbox_status_idx" ON "telegram_outbox" USING btree ("status");
