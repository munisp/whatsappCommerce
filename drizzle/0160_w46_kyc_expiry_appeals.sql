-- === W46 kyc (Coder A): TEN-6/TEN-7 KYC expiry + appeal path ===
-- ADDITIVE ONLY (hand-written; chained after 0151).
--
-- TEN-7: kyc_status gains 'appealed' — a rejected merchant may appeal
-- exactly once; the appeal re-review must be performed by a different
-- admin (4-eyes). appealedAt/appealReason/appealReviewedBy journal the
-- appeal lifecycle on kyc_applications.
-- TEN-6 uses the EXISTING expiresAt column (now stamped at approval per
-- risk tier) — no column change required.
ALTER TYPE "public"."kyc_status" ADD VALUE IF NOT EXISTS 'appealed';
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "appealedAt" timestamp;
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "appealReason" text;
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "appealReviewedBy" varchar(255);
