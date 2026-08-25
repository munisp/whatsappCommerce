-- W31 ar-invoices (Coder D): recorded payments against AR invoices.
-- `psp_reference` is the verified provider payment reference — UNIQUE so a
-- replayed webhook / double confirm can never double-record a payment.
CREATE TABLE IF NOT EXISTS "ar_invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"psp_reference" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'recorded' NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ar_invoice_payments_psp_ref_uniq" ON "ar_invoice_payments" USING btree ("psp_reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar_invoice_payments_invoice_idx" ON "ar_invoice_payments" USING btree ("invoice_id");
