-- W30 (Coder E, V3#4): retryable "approved_email_failed" state for Hermes PO
-- drafts. approvePO moves a PO here when supplier-email dispatch fails so the
-- caller sees an honest failure and can retry, instead of a fabricated
-- success. Additive enum value only.
ALTER TYPE "public"."hermes_po_status" ADD VALUE IF NOT EXISTS 'approved_email_failed';
