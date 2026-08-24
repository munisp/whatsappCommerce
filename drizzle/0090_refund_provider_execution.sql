-- W30 (Coder B, verify-v1 #9): provider refund execution bookkeeping.
-- Additive only. providerReference stores the PSP's refund reference;
-- metadata records the refund execution outcome (honest vocabulary:
-- refund_recorded vs refund_paid) and processed-confirmation evidence.
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "providerReference" varchar(256);
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
