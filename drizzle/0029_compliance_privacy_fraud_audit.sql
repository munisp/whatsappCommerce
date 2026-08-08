CREATE TYPE "public"."erasure_request_status" AS ENUM('pending', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."fraud_case_status" AS ENUM('pending', 'filed', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" varchar(64),
	"actor_role" varchar(32),
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" varchar(128),
	"tenant_id" varchar(36),
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"status" "erasure_request_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"blocked_reason" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processed_by" integer
);
--> statement-breakpoint
CREATE TABLE "fraud_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"payment_intent_id" varchar(64),
	"order_id" varchar(36),
	"customer_id" varchar(64),
	"fraud_score" numeric(5, 4) NOT NULL,
	"risk_level" varchar(16) NOT NULL,
	"status" "fraud_case_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp,
	"filed_at" timestamp,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "erasure_requests_user_idx" ON "erasure_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "erasure_requests_status_idx" ON "erasure_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fraud_cases_tenant_idx" ON "fraud_cases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "fraud_cases_status_idx" ON "fraud_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fraud_cases_payment_intent_idx" ON "fraud_cases" USING btree ("payment_intent_id");