-- W38 money-integrity (Coder A): refund_attempts + merchant_clawbacks.
-- ADDITIVE ONLY.
-- PAY-2: refund_attempts records every provider refund attempt with a
-- deterministic idempotency key so sweeps verify-before-retry instead of
-- blindly re-issuing refunds after a PSP timeout.
-- PAY-3: merchant_clawbacks records a clawback debit when a refund executes
-- after the escrow already settled/paid out (refund-after-payout), so the
-- platform never silently double-spends.
CREATE TABLE IF NOT EXISTS "refund_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"refund_id" varchar(36),
	"order_id" varchar(36),
	"provider" varchar(32) NOT NULL,
	"provider_ref" varchar(256),
	"idempotency_key" varchar(128) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(24) NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_attempts_tenant_idx" ON "refund_attempts" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_attempts_order_idx" ON "refund_attempts" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_attempts_refund_idx" ON "refund_attempts" USING btree ("refund_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_attempts_idem_idx" ON "refund_attempts" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_clawbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"refund_id" varchar(36),
	"escrow_id" varchar(36),
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"reason" text,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_clawbacks_tenant_idx" ON "merchant_clawbacks" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_clawbacks_order_idx" ON "merchant_clawbacks" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_clawbacks_refund_uniq" ON "merchant_clawbacks" USING btree ("refund_id");
--> statement-breakpoint
-- PAY-7: honest "provider refund still owed" order payment status for the
-- bulk-refund path (internal ledger refunded, provider leg pending sweep).
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'refund_pending';
