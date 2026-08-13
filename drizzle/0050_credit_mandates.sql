-- W13: repayment-at-source mandates + credit control plane.
-- payment_mandates: buyer-tenant debit authorizations (pending|active|revoked|failed).
CREATE TABLE IF NOT EXISTS "payment_mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"mandateRef" varchar(128) NOT NULL,
	"customerRef" varchar(128),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "payment_mandates" ADD CONSTRAINT "payment_mandates_tenantId_tenants_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_mandates_tenant_status_idx" ON "payment_mandates" USING btree ("tenantId","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_mandates_tenant_provider_ref_uniq" ON "payment_mandates" USING btree ("tenantId","provider","mandateRef");
--> statement-breakpoint
-- credit_limit_history: append-only audit of limit revisions.
CREATE TABLE IF NOT EXISTS "credit_limit_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accountId" uuid NOT NULL,
	"oldLimitCents" bigint NOT NULL,
	"newLimitCents" bigint NOT NULL,
	"score" integer,
	"reason" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "credit_limit_history" ADD CONSTRAINT "credit_limit_history_accountId_credit_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_limit_history_account_idx" ON "credit_limit_history" USING btree ("accountId");
--> statement-breakpoint
-- credit_accounts: mandate link + order-access suspension columns.
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "mandate_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "suspended" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp;
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "suspension_reason" varchar(255);
