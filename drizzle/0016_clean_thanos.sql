CREATE TABLE "dataset_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"createdBy" varchar(128),
	"label" varchar(256),
	"totalImages" integer NOT NULL,
	"bboxImages" integer NOT NULL,
	"qualityImages" integer NOT NULL,
	"classStats" jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "model_ab_tests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"modelName" varchar(128) NOT NULL,
	"championVersion" varchar(128) NOT NULL,
	"challengerVersion" varchar(128) NOT NULL,
	"trafficSplitPct" integer DEFAULT 20 NOT NULL,
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"championRequests" integer DEFAULT 0 NOT NULL,
	"challengerRequests" integer DEFAULT 0 NOT NULL,
	"championMetric" real,
	"challengerMetric" real,
	"pValue" real,
	"winner" varchar(32),
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"concludedAt" timestamp,
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "ds_snap_created_idx" ON "dataset_snapshots" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "ab_model_idx" ON "model_ab_tests" USING btree ("modelName");--> statement-breakpoint
CREATE INDEX "ab_status_idx" ON "model_ab_tests" USING btree ("status");