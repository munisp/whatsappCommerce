-- W40 TEN-5: GDPR erasure tombstones on kyc_documents.
-- ADDITIVE ONLY (hand-written, journaled after 0122).
-- Before W40, KYC document scans (S3 objects) and their OCR text were
-- invisible to GDPR erasure: privacy.requestErasure anonymized only
-- users/customers, leaving kyc_documents.fileKey/fileUrl/ocrRawText/
-- extractedData (raw PII, biometrics-adjacent) retained forever.
--
-- Erasure semantics (server/services/kycPrivacy.ts):
--   * DB-resident PII (ocrRawText, extractedData, vlmAnalysis,
--     doclingStructure, fileName, fileUrl) is nulled IMMEDIATELY at erasure
--     time — it is never left behind waiting on S3.
--   * The S3 object delete is attempted immediately; on success erased_at
--     is set. If the object store is unavailable, the row is tombstoned
--     (erasure_scheduled_at) and the scheduled /api/scheduled/kyc-erasure-sweep
--     cron retries the delete until erased_at is set. Honest limitation:
--     until erased_at is set, the S3 object MAY still exist (containing a
--     document scan); it is unreachable from the app because file_url is
--     already nulled.
ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "erasedAt" timestamp;
ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "erasureScheduledAt" timestamp;
