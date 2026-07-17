CREATE TABLE "quick_reply_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"title" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"category" varchar(60) DEFAULT 'general' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "qrt_tenant_idx" ON "quick_reply_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "qrt_category_idx" ON "quick_reply_templates" USING btree ("category");