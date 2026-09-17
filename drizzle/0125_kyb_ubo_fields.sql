-- W40 TEN-8: KYB UBO/PEP capture + re-screen journaling.
-- ADDITIVE ONLY (hand-written, journaled after 0124).
-- Before W40, sanctions/PEP screening covered the business name only:
-- no beneficial-owner concept, no PEP declaration, and screening ran only
-- at draft-save/review, so a merchant sanctioned post-approval was never
-- re-checked.
--
-- ubo_name / ubo_dob: primary ultimate beneficial owner (director) identity.
-- Screened through the SAME fail-closed sanctions path as the business name
-- (screenEntity — a UBO hit forces recommendation=reject; a degraded UBO
-- screen forces manual_review). pep_declared is capture-only (advisory).
-- last_screened_at: journaled by the periodic re-screen sweep
-- (/api/scheduled/kyb-rescreen) for every screened application.
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "uboName" varchar(255);
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "uboDob" varchar(10);
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "pepDeclared" boolean DEFAULT false;
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "lastScreenedAt" timestamp;
