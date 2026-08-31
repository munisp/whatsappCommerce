-- W31 ar-invoices (Coder D): AR invoices with payment links + reminders.
-- Additive-only. `invoice_no` is a tenant-scoped sequence (app generates
-- next = max+1 per tenant, unique index enforces no duplicates under
-- concurrency). `payment_link_ref` is the PSP reference the payment link was
-- minted with — globally unique so webhook resolution is unambiguous.
CREATE TABLE IF NOT EXISTS "ar_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_name" varchar(200),
	"customer_phone" varchar(20),
	"customer_email" varchar(320),
	"invoice_no" integer NOT NULL,
	"description" text,
	"amount_cents" bigint NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"due_date" timestamp,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"payment_link_ref" varchar(64),
	"psp_reference" varchar(128),
	"payment_url" text,
	"sent_at" timestamp,
	"viewed_at" timestamp,
	"paid_at" timestamp,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ar_invoices_tenant_no_uniq" ON "ar_invoices" USING btree ("tenant_id","invoice_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ar_invoices_payment_link_ref_uniq" ON "ar_invoices" USING btree ("payment_link_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar_invoices_tenant_status_idx" ON "ar_invoices" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar_invoices_tenant_due_idx" ON "ar_invoices" USING btree ("tenant_id","due_date");
