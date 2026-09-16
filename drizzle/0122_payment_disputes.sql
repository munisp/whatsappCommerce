-- W39 PAY-8: payment_disputes — PSP chargeback/dispute webhook records.
-- ADDITIVE ONLY (hand-written, journaled after 0121).
-- Before W39, chargeback/dispute PSP events were silently dropped by the
-- webhook handlers (bare 200), so a PSP could debit the platform balance
-- with no ledger/dispute record. Every dispute event is now persisted with
-- an explicit lifecycle status: open | won | lost | accepted.
-- Debit-on-lost semantics: a dispute opened here does NOT move money; when
-- the PSP reports the dispute lost (or the merchant accepts), the provider
-- has ALREADY debited the platform/merchant balance at the PSP level — the
-- 'lost'/'accepted' status is the honest record of that external debit and
-- the trigger for ops recovery (merchant clawback / reserve), NOT a new
-- internal double-entry. Internal wallet debits remain the responsibility of
-- the reconciliation/clawback flows (merchant_clawbacks, W38).
CREATE TABLE IF NOT EXISTS "payment_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36),
	"provider" varchar(32) NOT NULL,
	"provider_ref" varchar(256) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"amount_cents" bigint,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_disputes_tenant_idx" ON "payment_disputes" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_disputes_order_idx" ON "payment_disputes" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_disputes_ref_idx" ON "payment_disputes" USING btree ("provider_ref");
--> statement-breakpoint
-- Webhook redelivery idempotency: one dispute record per (provider, ref, kind).
CREATE UNIQUE INDEX IF NOT EXISTS "payment_disputes_uniq" ON "payment_disputes" USING btree ("provider", "provider_ref", "kind");
