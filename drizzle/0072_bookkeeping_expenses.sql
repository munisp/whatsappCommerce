-- W27 bookkeeping: merchant expense records (manual or receipt-photo OCR).
-- ALL money is INTEGER CENTS (kobo). Additive only.
-- status flow: awaiting_receipt → pending_confirm → confirmed | rejected.
CREATE TABLE IF NOT EXISTS "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"vendor" varchar(160),
	"category" varchar(64) DEFAULT 'general' NOT NULL,
	"expense_date" timestamp NOT NULL,
	"status" varchar(24) DEFAULT 'awaiting_receipt' NOT NULL,
	"source" varchar(24) DEFAULT 'manual' NOT NULL,
	"media_id" varchar(128),
	"ocr_text" text,
	"created_by_phone" varchar(32),
	"note" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_tenant_date_idx" ON "expenses" USING btree ("tenant_id","expense_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_tenant_status_idx" ON "expenses" USING btree ("tenant_id","status");