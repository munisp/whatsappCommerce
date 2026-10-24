-- === W62 findings (F9): durable transactional-email outbox. Emails were
-- fire-and-forget (audit W61 MEDIUM #9); this table persists them with a
-- unique idempotency key, bounded retry/backoff, and dead-letter. Additive
-- only; IF NOT EXISTS everywhere for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36),
	"idempotency_key" varchar(191) NOT NULL,
	"kind" varchar(48) NOT NULL,
	"to_email" varchar(320) NOT NULL,
	"subject" varchar(512) NOT NULL,
	"html" text NOT NULL,
	"text_body" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp,
	"last_error" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_outbox_idempotency_key_uniq" ON "email_outbox" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_retry_idx" ON "email_outbox" ("next_retry_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_status_idx" ON "email_outbox" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_tenant_idx" ON "email_outbox" ("tenant_id");
