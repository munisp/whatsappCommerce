CREATE TYPE "public"."whatsapp_notif_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'failed', 'simulated');--> statement-breakpoint
CREATE TABLE "whatsapp_notification_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"userId" integer,
	"orderId" varchar(36),
	"tenantId" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"notifType" varchar(64) NOT NULL,
	"templateName" varchar(128),
	"status" "whatsapp_notif_status" DEFAULT 'pending' NOT NULL,
	"wamid" varchar(128),
	"sentAt" timestamp,
	"deliveredAt" timestamp,
	"readAt" timestamp,
	"failedAt" timestamp,
	"failReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_notification_log" ADD CONSTRAINT "whatsapp_notification_log_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_notif_log_user_idx" ON "whatsapp_notification_log" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "wa_notif_log_order_idx" ON "whatsapp_notification_log" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX "wa_notif_log_tenant_idx" ON "whatsapp_notification_log" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "wa_notif_log_wamid_idx" ON "whatsapp_notification_log" USING btree ("wamid");--> statement-breakpoint
CREATE INDEX "wa_notif_log_created_idx" ON "whatsapp_notification_log" USING btree ("createdAt");