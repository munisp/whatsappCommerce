CREATE TYPE "public"."operator_template_category" AS ENUM('transactional', 'marketing', 'utility', 'authentication', 'custom');--> statement-breakpoint
CREATE TYPE "public"."sla_extension_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "dispute_evidence_submissions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispute_id" varchar(36) NOT NULL,
	"token" varchar(64) NOT NULL,
	"file_url" text,
	"file_key" text,
	"filename" varchar(255),
	"mime_type" varchar(128),
	"note" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_evidence_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"dispute_id" varchar(36) NOT NULL,
	"buyer_phone" varchar(32),
	"buyer_name" varchar(128),
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_evidence_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "escrow_sla_config" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36),
	"release_deadline_hours" integer DEFAULT 72 NOT NULL,
	"warning_hours" integer DEFAULT 24 NOT NULL,
	"auto_release_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_sla_extensions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"escrow_id" varchar(36) NOT NULL,
	"requested_by_tenant_id" varchar(36) NOT NULL,
	"extension_hours" integer DEFAULT 24 NOT NULL,
	"reason" text,
	"status" "sla_extension_status" DEFAULT 'pending' NOT NULL,
	"buyer_token" varchar(64) NOT NULL,
	"buyer_phone" varchar(30),
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"new_deadline" timestamp,
	CONSTRAINT "escrow_sla_extensions_buyer_token_unique" UNIQUE("buyer_token")
);
--> statement-breakpoint
CREATE TABLE "merchant_onboarding_progress" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"completed_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"step_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_onboarding_progress_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "operator_templates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"category" "operator_template_category" DEFAULT 'transactional' NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"headerText" varchar(255),
	"bodyText" text NOT NULL,
	"footerText" varchar(255),
	"variables" jsonb,
	"isActive" boolean DEFAULT true NOT NULL,
	"description" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operator_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN "min_scan_confidence" numeric(4, 2) DEFAULT '0.70' NOT NULL;--> statement-breakpoint
ALTER TABLE "escrow_sla_extensions" ADD CONSTRAINT "escrow_sla_extensions_escrow_id_escrow_transactions_id_fk" FOREIGN KEY ("escrow_id") REFERENCES "public"."escrow_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "des_dispute_idx" ON "dispute_evidence_submissions" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "des_token_idx" ON "dispute_evidence_submissions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "det_token_idx" ON "dispute_evidence_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "det_dispute_idx" ON "dispute_evidence_tokens" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "sla_tenant_idx" ON "escrow_sla_config" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sla_ext_escrow_idx" ON "escrow_sla_extensions" USING btree ("escrow_id");--> statement-breakpoint
CREATE INDEX "sla_ext_token_idx" ON "escrow_sla_extensions" USING btree ("buyer_token");--> statement-breakpoint
CREATE INDEX "merchant_onboarding_tenant_idx" ON "merchant_onboarding_progress" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "op_tmpl_category_idx" ON "operator_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "op_tmpl_active_idx" ON "operator_templates" USING btree ("isActive");