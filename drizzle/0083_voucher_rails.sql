-- W27 (Coder G): government / NGO voucher rails (issue / redeem / reconcile).
-- Additive only. ALL money is INTEGER CENTS.
CREATE TABLE IF NOT EXISTS "voucher_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"issuer" varchar(160) NOT NULL,
	"name" varchar(160) NOT NULL,
	"budget_cents" integer NOT NULL,
	"issued_cents" integer DEFAULT 0 NOT NULL,
	"redeemed_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"eligible_phones" jsonb,
	"eligible_categories" jsonb,
	"expires_at" timestamp,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"program_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"recipient_phone" varchar(32) NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'issued' NOT NULL,
	"order_id" varchar(36),
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"redeemed_at" timestamp,
	"expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_program_id_voucher_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."voucher_programs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vouchers_code_uniq" ON "vouchers" USING btree ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voucher_programs_tenant_idx" ON "voucher_programs" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voucher_programs_status_idx" ON "voucher_programs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vouchers_program_idx" ON "vouchers" USING btree ("program_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vouchers_recipient_idx" ON "vouchers" USING btree ("tenant_id","recipient_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vouchers_status_idx" ON "vouchers" USING btree ("status");
