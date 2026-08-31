-- W31 Coder B (scheduled-batch): payment scheduling + batch payments.
-- scheduled_payments: future wallet debits claimed exactly once by the
-- /api/scheduled/execute-payments cron (guarded pending->claimed UPDATE;
-- the wallet_tx reference `sched:<id>` is the durable idempotency backstop
-- via wallet_tx_wallet_ref_uniq, 0053). kind='vendor_bill' references Coder
-- A's vendor_bills by ID only (no FK — this branch must not depend on the
-- 0100 table existing). status vocabulary: pending | claimed | executed |
-- failed | cancelled | insufficient_funds (honest, merchant-retryable).
CREATE TABLE IF NOT EXISTS "scheduled_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"target_id" varchar(64),
	"recipient" jsonb,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"metadata" jsonb,
	"created_by" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"total_cents" bigint NOT NULL,
	"item_count" integer NOT NULL,
	"executed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_payments_idem_uniq" ON "scheduled_payments" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_payments_status_exec_idx" ON "scheduled_payments" USING btree ("status","execute_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_payments_tenant_idx" ON "scheduled_payments" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_batches_tenant_idx" ON "payment_batches" USING btree ("tenant_id","created_at");
