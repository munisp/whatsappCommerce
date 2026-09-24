-- === W47 stakeholders (Coder C): ONB-S-8 vendor payee vetting ===
-- ADDITIVE ONLY (hand-written; chained after 0167).
--
-- vendors registry: deduped (tenant_id, name_key) vendor identity with
-- structured, format-validated payout account fields and a KYB-tier gate
-- before the first wallet payout. vendor_bills.vendor_id links bills to
-- the vetted vendor row; payee details lock once a bill is approved.
CREATE TABLE IF NOT EXISTS "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(160) NOT NULL,
	"name_key" varchar(160) NOT NULL,
	"phone" varchar(30),
	"email" varchar(320),
	"bank_code" varchar(16),
	"account_number" varchar(20),
	"account_name" varchar(160),
	"kyb_tier" varchar(16) DEFAULT 'none' NOT NULL,
	"first_paid_at" timestamp,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_tenant_namekey_uq" ON "vendors" USING btree ("tenant_id","name_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendors_tenant_idx" ON "vendors" USING btree ("tenant_id","created_at");
--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "vendor_id" uuid;
