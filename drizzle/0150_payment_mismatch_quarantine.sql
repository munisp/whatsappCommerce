-- === W45 money-intents (Coder B2): PAY-13 payment mismatch quarantine ===
-- ADDITIVE ONLY (hand-written; chained after 0142).
--
-- payment_mismatch_quarantine: when a PSP webhook confirms money IN HAND at an
-- amount/currency that disagrees with the stored payment record, the pinned
-- paymentConfirm.ts marks the payment failed — but the provider really did
-- collect money. This table quarantines the mismatched funds so ops can
-- reconcile, an ops alert fires, and an auto-refund via executeProviderRefund
-- is attempted for the ACTUAL collected amount (server/services/payments/
-- paymentMismatchQuarantine.ts).
CREATE TABLE IF NOT EXISTS "payment_mismatch_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"payment_intent_id" varchar(36),
	"order_id" varchar(36),
	"reference" varchar(256) NOT NULL,
	"provider" varchar(32) NOT NULL,
	-- expected vs provider-reported amounts in integer minor units
	"expected_amount_minor" bigint NOT NULL,
	"actual_amount_minor" bigint,
	"expected_currency" varchar(3) NOT NULL,
	"actual_currency" varchar(3),
	"reason" text NOT NULL,
	-- quarantined | auto_refund_initiated | auto_refund_paid | auto_refund_failed | resolved
	"status" varchar(24) DEFAULT 'quarantined' NOT NULL,
	"refund_reference" varchar(256),
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_mismatch_quarantine_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_mismatch_quarantine_tenant_idx" ON "payment_mismatch_quarantine" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_mismatch_quarantine_status_idx" ON "payment_mismatch_quarantine" USING btree ("status");
