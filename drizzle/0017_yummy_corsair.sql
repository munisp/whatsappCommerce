CREATE TYPE "public"."wa_delivery_status" AS ENUM('sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TABLE "wa_message_delivery_receipts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"waMessageId" varchar(128) NOT NULL,
	"recipientPhone" varchar(30),
	"status" "wa_delivery_status" NOT NULL,
	"errorCode" varchar(32),
	"errorMessage" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"rawPayload" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wa_dr_tenant_idx" ON "wa_message_delivery_receipts" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "wa_dr_msg_idx" ON "wa_message_delivery_receipts" USING btree ("waMessageId");--> statement-breakpoint
CREATE INDEX "wa_dr_status_idx" ON "wa_message_delivery_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wa_dr_ts_idx" ON "wa_message_delivery_receipts" USING btree ("timestamp");