-- W32 recurring-tiers (Coder B): payout speed tiers (Melio instant-vs-standard).
-- Additive ALTERs only: scheduled_payments gains `speed` ('standard' default,
-- 'instant' executes inline at schedule time with a platform fee leg —
-- wallet_tx reference `schedfee:<id>` to the deterministic platform fee
-- wallet, integer cents, fee + net == gross); the instant fee rate is the
-- platform-level escrow_config.instant_payout_fee_bps (basis points).
ALTER TABLE "scheduled_payments" ADD COLUMN IF NOT EXISTS "speed" varchar(16) DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "instant_payout_fee_bps" integer DEFAULT 50 NOT NULL;
