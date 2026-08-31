-- W31 vendor-bills (Coder A): vendor bills AP inbox.
-- Melio-inspired bill lifecycle: capture (photo/pdf/whatsapp/manual/odoo) →
-- OCR extraction → pending → (partial payments) → paid, with honest
-- partially_paid / overdue / cancelled states. Money columns are integer
-- cents (bigint). payment_ref is the idempotency anchor for wallet debits.
CREATE TABLE IF NOT EXISTS "vendor_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"vendor_name" varchar(160) NOT NULL,
	"vendor_contact" jsonb,
	"bill_number" varchar(64),
	"description" text,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"issue_date" timestamp,
	"due_date" timestamp,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"capture_source" varchar(16) DEFAULT 'manual' NOT NULL,
	"capture_media_key" varchar(160),
	"ocr_confidence" numeric,
	"ocr_raw" jsonb,
	"payment_ref" varchar(128),
	"approval_id" varchar(64),
	"odoo_sync_state" varchar(16),
	"created_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_bills_tenant_status_idx" ON "vendor_bills" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_bills_tenant_due_idx" ON "vendor_bills" USING btree ("tenant_id","due_date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_bills_payment_ref_uniq" ON "vendor_bills" USING btree ("payment_ref");
