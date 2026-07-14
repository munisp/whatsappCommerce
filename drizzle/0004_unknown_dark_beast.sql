CREATE TYPE "public"."notification_type" AS ENUM('escrow_held', 'delivery_confirmed', 'escrow_settled', 'escrow_refunded', 'dispute_opened', 'dispute_resolved', 'withdrawal_processed', 'shipment_update', 'system');--> statement-breakpoint
CREATE TABLE "merchant_notifications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb,
	"read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notif_tenant_idx" ON "merchant_notifications" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notif_read_idx" ON "merchant_notifications" USING btree ("tenant_id","read");--> statement-breakpoint
CREATE INDEX "notif_created_idx" ON "merchant_notifications" USING btree ("created_at");