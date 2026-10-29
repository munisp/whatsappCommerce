-- W58 fix: processed_webhook_events.id was varchar(64) — too small for Meta
-- WhatsApp wamids (e.g. "wamid.HBgN…==" is 66 chars) and for tenant-prefixed
-- recon claim ids (sliced to 160 in webhookDedupe/reconMatch). An oversized
-- value failed the claim INSERT, the webhook handler failed closed, and the
-- inbound message was silently dropped (never processed, never replied to).
-- Widen the PK to varchar(160). Increasing a varchar length is a metadata-only
-- change in Postgres (no table rewrite, minimal lock).
ALTER TABLE "processed_webhook_events" ALTER COLUMN "id" TYPE varchar(160);
--> statement-breakpoint
