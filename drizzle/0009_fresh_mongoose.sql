CREATE TYPE "public"."wa_webhook_status" AS ENUM('received', 'processed', 'failed', 'retried', 'dead');--> statement-breakpoint
CREATE TABLE "wa_webhook_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"messageId" varchar(128),
	"phoneNumberId" varchar(64),
	"waPhoneNumber" varchar(30),
	"messageType" varchar(30),
	"rawPayload" jsonb NOT NULL,
	"status" "wa_webhook_status" DEFAULT 'received' NOT NULL,
	"retryCount" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"processedAt" timestamp,
	"nextRetryAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wa_wh_status_idx" ON "wa_webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wa_wh_phone_idx" ON "wa_webhook_events" USING btree ("waPhoneNumber");--> statement-breakpoint
CREATE INDEX "wa_wh_retry_idx" ON "wa_webhook_events" USING btree ("nextRetryAt");