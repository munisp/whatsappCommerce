-- W41 (Coder C): RMA/returns lifecycle + multi-currency DISPLAY config —
-- ADDITIVE ONLY (hand-written, journaled after 0126; idx 0127-0128
-- reserved for Coders A/B, merger re-chains per SPEC_W41).
--
-- ORD-6 / UC-4: rma_requests — buyer-initiated returns with a real state
-- machine (requested → approved|rejected → received → restocked → refunded
-- |closed). Money side stays on the W38 refund path (refundEscrowAtomic
-- caps/idempotency) or a wallet credit; stock side reuses the W38 unified
-- restock helpers. Refund-to-wallet counts toward the cumulative refunded
-- total (walletCreditCents + refundedCents ≤ order escrow remaining).
--
-- UC-5: tenants.displayCurrency + tenants.displayFxRates (manual,
-- tenant-set rates with last_updated — NO live feed this wave). DISPLAY
-- ONLY: the ledger and every PSP charge stay in NGN kobo.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "displayCurrency" varchar(3);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "displayFxRates" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rma_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"buyer_ref" varchar(64) NOT NULL,
	"items" jsonb NOT NULL,
	"reason" text NOT NULL,
	"evidence_media_id" varchar(128),
	"status" varchar(16) DEFAULT 'requested' NOT NULL,
	"requested_via" varchar(16) DEFAULT 'whatsapp' NOT NULL,
	"refund_method" varchar(16),
	"refunded_cents" bigint,
	"merchant_note" text,
	"decided_at" timestamp,
	"received_at" timestamp,
	"restocked_at" timestamp,
	"refunded_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "rma_status_chk" CHECK ("status" IN ('requested','approved','rejected','received','restocked','refunded','closed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_requests_tenant_order_idx" ON "rma_requests" USING btree ("tenant_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_requests_tenant_status_idx" ON "rma_requests" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_requests_buyer_idx" ON "rma_requests" USING btree ("tenant_id","buyer_ref");
