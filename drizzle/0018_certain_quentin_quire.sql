CREATE TYPE "public"."hermes_po_status" AS ENUM('pending', 'approved', 'rejected', 'sent');--> statement-breakpoint
CREATE TABLE "hermes_configs" (
	"tenantId" varchar(36) PRIMARY KEY NOT NULL,
	"hermesAgentUrl" text,
	"hermesApiKey" text,
	"enabledSkills" text,
	"autoApproveBelow" integer,
	"notifyPhone" varchar(30),
	"woocommerceApiUrl" text,
	"woocommerceKey" text,
	"woocommerceSecret" text,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" integer NOT NULL,
	"updatedAt" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_event_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"eventType" varchar(64) NOT NULL,
	"eventId" varchar(36),
	"skillsTriggered" text,
	"success" boolean DEFAULT true NOT NULL,
	"durationMs" integer,
	"errorMessage" text,
	"rawPayload" jsonb,
	"createdAt" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_po_drafts" (
	"poId" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"supplierName" varchar(128) NOT NULL,
	"supplierEmail" varchar(256) NOT NULL,
	"merchantPhone" varchar(30),
	"sku" varchar(64) NOT NULL,
	"productName" varchar(256) NOT NULL,
	"quantity" integer NOT NULL,
	"unitCost" integer NOT NULL,
	"totalCost" integer NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"approvalToken" varchar(32) NOT NULL,
	"status" "hermes_po_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"approvedBy" varchar(36),
	"approvedAt" integer,
	"createdAt" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hermes_log_tenant_idx" ON "hermes_event_log" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "hermes_log_event_type_idx" ON "hermes_event_log" USING btree ("eventType");--> statement-breakpoint
CREATE INDEX "hermes_log_created_idx" ON "hermes_event_log" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "hermes_po_tenant_idx" ON "hermes_po_drafts" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "hermes_po_status_idx" ON "hermes_po_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hermes_po_created_idx" ON "hermes_po_drafts" USING btree ("createdAt");