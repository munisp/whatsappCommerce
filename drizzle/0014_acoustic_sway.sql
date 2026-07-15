CREATE TABLE "finetune_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"endedAt" timestamp,
	"exitCode" integer,
	"dryRun" boolean DEFAULT true NOT NULL,
	"triggeredBy" varchar(128) DEFAULT 'ui' NOT NULL,
	"logSnapshot" text,
	"status" varchar(32) DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_image_collections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"className" varchar(128) NOT NULL,
	"displayName" varchar(256) NOT NULL,
	"imageUrl" text NOT NULL,
	"imageKey" text NOT NULL,
	"source" varchar(64) DEFAULT 'camera' NOT NULL,
	"notes" text,
	"uploadedBy" varchar(36),
	"usedInTraining" boolean DEFAULT false NOT NULL,
	"qualityScore" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visual_inventory_sessions" ADD COLUMN "scanLocation" varchar(256);--> statement-breakpoint
CREATE INDEX "ft_runs_started_idx" ON "finetune_runs" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "ft_runs_status_idx" ON "finetune_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pic_tenant_idx" ON "product_image_collections" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "pic_class_idx" ON "product_image_collections" USING btree ("className");--> statement-breakpoint
CREATE INDEX "pic_training_idx" ON "product_image_collections" USING btree ("usedInTraining");