CREATE TYPE "public"."ab_winner_criteria" AS ENUM('read_rate', 'delivery_rate', 'click_rate');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'scheduled', 'sending', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inventory_sync_status" AS ENUM('idle', 'syncing', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recipient_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'failed', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."template_approval_status" AS ENUM('none', 'draft', 'submitted', 'approved', 'rejected', 'paused');--> statement-breakpoint
CREATE TYPE "public"."template_version_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "broadcast_ab_tests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"campaignId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"variantATemplateId" varchar(36) NOT NULL,
	"variantBTemplateId" varchar(36) NOT NULL,
	"variantAName" varchar(100) DEFAULT 'Variant A' NOT NULL,
	"variantBName" varchar(100) DEFAULT 'Variant B' NOT NULL,
	"splitRatio" integer DEFAULT 50 NOT NULL,
	"winnerCriteria" "ab_winner_criteria" DEFAULT 'read_rate' NOT NULL,
	"winnerVariant" varchar(1),
	"testEndAt" timestamp,
	"variantASent" integer DEFAULT 0 NOT NULL,
	"variantADelivered" integer DEFAULT 0 NOT NULL,
	"variantARead" integer DEFAULT 0 NOT NULL,
	"variantBSent" integer DEFAULT 0 NOT NULL,
	"variantBDelivered" integer DEFAULT 0 NOT NULL,
	"variantBRead" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_campaigns" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"templateId" varchar(36),
	"templateVersionId" varchar(36),
	"isAbTest" boolean DEFAULT false NOT NULL,
	"abTestId" varchar(36),
	"segment" varchar(100) DEFAULT 'all',
	"segmentFilter" jsonb,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"scheduledAt" timestamp,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"totalRecipients" integer DEFAULT 0 NOT NULL,
	"sentCount" integer DEFAULT 0 NOT NULL,
	"deliveredCount" integer DEFAULT 0 NOT NULL,
	"readCount" integer DEFAULT 0 NOT NULL,
	"failedCount" integer DEFAULT 0 NOT NULL,
	"createdBy" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"campaignId" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"name" varchar(255),
	"variables" jsonb,
	"status" "recipient_status" DEFAULT 'pending' NOT NULL,
	"sentAt" timestamp,
	"deliveredAt" timestamp,
	"readAt" timestamp,
	"failedAt" timestamp,
	"failureReason" varchar(500),
	"messageId" varchar(100),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"odooProductId" integer,
	"stockQty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reservedQty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"availableQty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"lastSyncedAt" timestamp DEFAULT now() NOT NULL,
	"syncSource" varchar(30) DEFAULT 'odoo' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_sync_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"source" varchar(30) DEFAULT 'odoo' NOT NULL,
	"status" "inventory_sync_status" DEFAULT 'idle' NOT NULL,
	"recordsSynced" integer DEFAULT 0 NOT NULL,
	"errors" text,
	"syncedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"templateId" varchar(36) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"bodyText" text NOT NULL,
	"headerText" varchar(255),
	"footerText" varchar(255),
	"variables" jsonb,
	"buttons" jsonb,
	"status" "template_version_status" DEFAULT 'draft' NOT NULL,
	"changeSummary" varchar(500),
	"changedBy" varchar(64),
	"publishedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN "approvalStatus" "template_approval_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN "approvalSubmittedAt" timestamp;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN "approvalUpdatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN "rejectionReason" text;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN "metaTemplateId" varchar(128);--> statement-breakpoint
CREATE INDEX "ab_tests_campaign_idx" ON "broadcast_ab_tests" USING btree ("campaignId");--> statement-breakpoint
CREATE INDEX "ab_tests_tenant_idx" ON "broadcast_ab_tests" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "broadcast_tenant_idx" ON "broadcast_campaigns" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "broadcast_status_idx" ON "broadcast_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_campaign_idx" ON "broadcast_recipients" USING btree ("campaignId");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_status_idx" ON "broadcast_recipients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inv_snap_tenant_idx" ON "inventory_snapshots" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_snap_product_idx" ON "inventory_snapshots" USING btree ("tenantId","productId");--> statement-breakpoint
CREATE INDEX "inv_sync_log_tenant_idx" ON "inventory_sync_log" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "inv_sync_log_synced_idx" ON "inventory_sync_log" USING btree ("syncedAt");--> statement-breakpoint
CREATE INDEX "template_versions_template_idx" ON "template_versions" USING btree ("templateId");--> statement-breakpoint
CREATE INDEX "template_versions_status_idx" ON "template_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_unique_idx" ON "template_versions" USING btree ("templateId","version");