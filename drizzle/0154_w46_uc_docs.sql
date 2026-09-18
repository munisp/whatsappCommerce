-- === W46 uc-docs (Coder D): UC-12 customer statements, UC-19 proforma invoices, UC-20 agents/commissions ===
-- ADDITIVE ONLY (hand-written; chained after 0151).
--
-- UC-12: per-customer statement of account generated from real orders +
-- payments, delivered as a chat document (WA/TG).
-- UC-19: proforma invoice / formal quotation document with a guarded
-- convert-to-order transition (exactly one order per proforma).
-- UC-20: agents/resellers with order attribution and commission statements
-- that pay out through the customer-wallet payout rail (creditWallet reason
-- 'agent_commission'; refId `agent-commission:<statementId>`).
CREATE TABLE IF NOT EXISTS "customer_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_phone" varchar(30) NOT NULL,
	"customer_name" varchar(255),
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"total_invoiced_cents" integer DEFAULT 0 NOT NULL,
	"total_paid_cents" integer DEFAULT 0 NOT NULL,
	"outstanding_cents" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'generated' NOT NULL,
	"pdf_path" varchar(255),
	"wa_message_id" varchar(128),
	"channel" varchar(16),
	"metadata" jsonb,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_statements_tenant_idx" ON "customer_statements" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_statements_phone_idx" ON "customer_statements" USING btree ("tenant_id","customer_phone");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proforma_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"proforma_no" integer NOT NULL,
	"customer_name" varchar(255),
	"customer_phone" varchar(30),
	"customer_email" varchar(320),
	"items" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"valid_until" timestamp,
	"rfq_id" varchar(36),
	"order_id" varchar(36),
	"pdf_path" varchar(255),
	"wa_message_id" varchar(128),
	"channel" varchar(16),
	"notes" text,
	"metadata" jsonb,
	"sent_at" timestamp,
	"converted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proforma_invoices_tenant_no_uniq" ON "proforma_invoices" USING btree ("tenant_id","proforma_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proforma_invoices_tenant_idx" ON "proforma_invoices" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proforma_invoices_status_idx" ON "proforma_invoices" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"code" varchar(32) NOT NULL,
	"commission_bps" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_code_uniq" ON "agents" USING btree ("tenant_id","code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_tenant_idx" ON "agents" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"order_total_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"statement_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_commissions_agent_order_uniq" ON "agent_commissions" USING btree ("agent_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_commissions_tenant_idx" ON "agent_commissions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_commissions_statement_idx" ON "agent_commissions" USING btree ("statement_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_commission_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"commission_count" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'generated' NOT NULL,
	"pdf_path" varchar(255),
	"wa_message_id" varchar(128),
	"channel" varchar(16),
	"payout_ref" varchar(160),
	"metadata" jsonb,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_comm_stmt_tenant_idx" ON "agent_commission_statements" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_comm_stmt_agent_idx" ON "agent_commission_statements" USING btree ("agent_id");
