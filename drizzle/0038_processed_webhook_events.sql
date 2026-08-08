CREATE TABLE "processed_webhook_events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"type" varchar(64) NOT NULL,
	"processedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "processed_webhook_events_processed_at_idx" ON "processed_webhook_events" USING btree ("processedAt");--> statement-breakpoint
CREATE INDEX "processed_webhook_events_tenant_idx" ON "processed_webhook_events" USING btree ("tenantId");
