CREATE TABLE "hermes_health_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"layer" varchar(32) NOT NULL,
	"online" boolean NOT NULL,
	"latencyMs" integer DEFAULT 0 NOT NULL,
	"recordedAt" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hermes_health_log_layer_idx" ON "hermes_health_log" USING btree ("layer");--> statement-breakpoint
CREATE INDEX "hermes_health_log_recorded_idx" ON "hermes_health_log" USING btree ("recordedAt");