-- W41 (Coder A, UC-1/UC-6): buyer installments + tokenized customer payment
-- methods.
--
-- buyer_installment_plans: order-linked layaway/BNPL plans. The buyer pays a
-- down payment at order confirm (a normal payment link whose reference is
-- down_payment_ref — confirmed by the PINNED paymentConfirm path, with the
-- plan activated by the adjacent webhook hook), then the remaining schedule
-- is charged off-session against a saved customer_payment_tokens row. Status:
-- pending_down → active → paid | defaulted | cancelled. Fulfillment is gated
-- on plan status (COD-like exposure): the order ships only when the plan is
-- 'paid' (or no plan exists).
--
-- buyer_plan_charges: durable ledger of every off-session buyer charge
-- (installment `bipcap:` + one-tap reorder `bipreorder:`), mirroring the W38
-- pot_charges pattern — 'pending'/'settlement_failed' rows are converged by
-- the verify-first reconcile sweep via the provider's READ-ONLY fetchStatus;
-- a charge is NEVER blind-retried. Exactly-once by the unique reference.
--
-- customer_payment_tokens: reusable PSP authorization tokens (Paystack
-- reusable_authorization / flutterwave card token) saved ONLY after an
-- explicit buyer consent prompt; token_enc is AES-256-GCM encrypted with the
-- v1: envelope (services/crypto/secrets.ts). NEVER a PAN — only the PSP
-- authorization handle + a display label (brand •••• last4).
-- ADDITIVE ONLY.
CREATE TABLE IF NOT EXISTS "buyer_installment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"buyer_phone" varchar(32) NOT NULL,
	"total_cents" bigint NOT NULL,
	"down_payment_cents" bigint NOT NULL,
	"down_payment_ref" varchar(160) NOT NULL,
	"down_payment_paid_at" timestamp,
	"installments" integer NOT NULL,
	"schedule" jsonb NOT NULL,
	"token_id" uuid,
	"save_card_consent" boolean DEFAULT false NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending_down' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_installment_plans_down_ref_uniq" ON "buyer_installment_plans" USING btree ("down_payment_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_installment_plans_tenant_status_idx" ON "buyer_installment_plans" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_installment_plans_order_idx" ON "buyer_installment_plans" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buyer_plan_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"plan_id" uuid,
	"order_id" varchar(36),
	"token_id" uuid,
	"provider" varchar(30) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"seq" integer,
	"reference" varchar(160) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"provider_status" varchar(40),
	"raw_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_plan_charges_reference_uniq" ON "buyer_plan_charges" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_plan_charges_plan_idx" ON "buyer_plan_charges" USING btree ("plan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_plan_charges_status_idx" ON "buyer_plan_charges" USING btree ("status");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "buyer_plan_charges" ADD CONSTRAINT "buyer_plan_charges_plan_id_buyer_installment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."buyer_installment_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_payment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"buyer_phone" varchar(32) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"token_enc" text NOT NULL,
	"display_label" varchar(64),
	"consent_text" text NOT NULL,
	"consent_at" timestamp DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_payment_tokens_buyer_idx" ON "customer_payment_tokens" USING btree ("tenant_id","buyer_phone","status");
