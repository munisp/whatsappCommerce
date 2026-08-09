CREATE TABLE IF NOT EXISTS "credit_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_tenant_id" varchar(36) NOT NULL,
	"buyer_tenant_id" varchar(36) NOT NULL,
	"limit_cents" bigint DEFAULT 0 NOT NULL,
	"outstanding_cents" bigint DEFAULT 0 NOT NULL,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"score" integer,
	"score_reasons" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_accounts_pair_uniq" ON "credit_accounts" USING btree ("supplier_tenant_id","buyer_tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_accounts_buyer_idx" ON "credit_accounts" USING btree ("buyer_tenant_id");
