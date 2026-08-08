ALTER TABLE "broadcast_campaigns" ADD COLUMN IF NOT EXISTS "scheduledAt" timestamp;--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD COLUMN IF NOT EXISTS "segmentFilter" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_scheduled_idx" ON "broadcast_campaigns" USING btree ("status","scheduledAt");
