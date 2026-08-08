DO $$ BEGIN
  ALTER TYPE "public"."whatsapp_notif_status" ADD VALUE 'dead';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "whatsapp_notification_log" ADD COLUMN IF NOT EXISTS "errorText" text;
--> statement-breakpoint
ALTER TABLE "whatsapp_notification_log" ADD COLUMN IF NOT EXISTS "statusTimestamps" jsonb;
--> statement-breakpoint
ALTER TABLE "whatsapp_notification_log" ADD COLUMN IF NOT EXISTS "payload" jsonb;
--> statement-breakpoint
ALTER TABLE "whatsapp_notification_log" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "whatsapp_notification_log" ADD COLUMN IF NOT EXISTS "nextRetryAt" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_notif_log_retry_idx" ON "whatsapp_notification_log" USING btree ("nextRetryAt");
