-- W18: manufacturer credit programs (F-manufacturer-programs, part 2).
-- A manufacturer_credit_programs row is a manufacturer/brand tenant's credit
-- program for its merchant buyers: per-buyer exposure cap, total book cap,
-- single-buyer concentration cap, allowed tenors, default fee, and optional
-- scoring-weight overrides. credit_accounts.program_id links a trade-credit
-- account (supplier_tenant_id = manufacturer tenant) into the program book.
-- Additive only.
CREATE TABLE IF NOT EXISTS "manufacturer_credit_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"max_exposure_cents" bigint NOT NULL,
	"program_cap_cents" bigint NOT NULL,
	"concentration_cap_bps" integer DEFAULT 10000 NOT NULL,
	"allowed_tenor_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fee_bps" integer DEFAULT 0 NOT NULL,
	"scoring_weights" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manufacturer_credit_programs_tenant_idx" ON "manufacturer_credit_programs" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "manufacturer_credit_programs_tenant_name_uniq" ON "manufacturer_credit_programs" USING btree ("tenant_id","name");
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "program_id" varchar(36);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_accounts_program_idx" ON "credit_accounts" USING btree ("program_id");
