-- W31 vendor-bills (Coder A): append-only audit trail for vendor_bills.
-- Every lifecycle transition (created, captured, updated, payment_recorded,
-- partially_paid, paid, overdue, cancelled, approval_requested, ...) appends
-- exactly one row; consumers never mutate history.
CREATE TABLE IF NOT EXISTS "vendor_bill_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"event" varchar(32) NOT NULL,
	"actor" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_bill_events_bill_idx" ON "vendor_bill_events" USING btree ("bill_id","created_at");
