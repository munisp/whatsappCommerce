-- W33 tax-statements (Coder A): supplier tax profiles (Melio W-9 analog).
-- One profile per (tenant, supplier) where the supplier is either another
-- platform tenant (supplier_tenant_id) or an external vendor referenced by
-- vendor_ref (vendor_bills vendor without a tenant). The unique index uses
-- COALESCE(supplier_tenant_id, vendor_ref) so exactly one profile exists per
-- supplier identity; capture is OPTIONAL (KYB onboarding / vendor_bill
-- create accept tax fields but never require them). withholding_bps is
-- informational labelling only — no withholding rail exists (honest note on
-- generated statements, never silently deducted).
CREATE TABLE IF NOT EXISTS "supplier_tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"supplier_tenant_id" varchar(36),
	"vendor_name" varchar(160) NOT NULL,
	"vendor_ref" varchar(128),
	"tax_id" varchar(64),
	"tax_id_type" varchar(16),
	"country_code" char(2),
	"withholding_bps" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_tax_profiles_tenant_supplier_uniq" ON "supplier_tax_profiles" USING btree ("tenant_id",(coalesce(supplier_tenant_id, vendor_ref)));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_tax_profiles_tenant_idx" ON "supplier_tax_profiles" USING btree ("tenant_id","vendor_name");
