DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'offline_msg_status') THEN
    CREATE TYPE "public"."offline_msg_status" AS ENUM('queued', 'delivered', 'failed');
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TYPE "public"."alert_rule_type" ADD VALUE 'escalation_count';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offline_message_queue" (
"id" varchar(36) PRIMARY KEY NOT NULL,
"sessionId" varchar(36) NOT NULL,
"tenantId" varchar(36) NOT NULL,
"waPhoneNumber" varchar(30) NOT NULL,
"message" text NOT NULL,
"direction" varchar(10) DEFAULT 'outbound' NOT NULL,
"status" "offline_msg_status" DEFAULT 'queued' NOT NULL,
"queuedAt" timestamp DEFAULT now() NOT NULL,
"deliveredAt" timestamp,
"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_media_files" (
"id" varchar(36) PRIMARY KEY NOT NULL,
"tenantId" varchar(36) NOT NULL,
"conversationId" varchar(36),
"waPhoneNumber" varchar(20),
"fileName" varchar(255) NOT NULL,
"mimeType" varchar(128) NOT NULL,
"fileSize" integer,
"storageKey" varchar(512) NOT NULL,
"storageUrl" varchar(1024) NOT NULL,
"documentType" varchar(32) DEFAULT 'other' NOT NULL,
"aiScanResult" jsonb,
"uploadedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "smsFailoverEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "omq_session_idx" ON "offline_message_queue" USING btree ("sessionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "omq_phone_idx" ON "offline_message_queue" USING btree ("waPhoneNumber");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "omq_status_idx" ON "offline_message_queue" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_media_tenant_idx" ON "whatsapp_media_files" USING btree ("tenantId");
