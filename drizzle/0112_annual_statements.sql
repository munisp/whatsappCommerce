-- W33 tax-statements (Coder A): annual supplier statements (Melio 1099
-- analog). One row per (tenant, supplier, year, currency) — mixed-currency
-- years produce SEPARATE rows, never summed across currencies. Status
-- vocabulary is honest: 'generated' only after the PDF file is actually
-- written, 'sent' only after the WhatsApp document push returns, 'viewed'
-- when the supplier reads it. unique(tenant, supplier, year, currency) makes
-- regeneration idempotent (replace the file, update the row).
CREATE TABLE IF NOT EXISTS "annual_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"supplier_tenant_id" varchar(36),
	"vendor_ref" varchar(128),
	"vendor_name" varchar(160) NOT NULL,
	"year" integer NOT NULL,
	"total_paid_cents" bigint DEFAULT 0 NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) NOT NULL,
	"withholding_cents" bigint DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'generated' NOT NULL,
	"pdf_path" varchar(256),
	"wa_message_id" varchar(128),
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annual_statements_tenant_supplier_year_uniq" ON "annual_statements" USING btree ("tenant_id",(coalesce(supplier_tenant_id, vendor_ref)),"year","currency");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annual_statements_tenant_year_idx" ON "annual_statements" USING btree ("tenant_id","year");
