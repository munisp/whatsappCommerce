CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"customer_id" varchar(36),
	"channel" varchar(30) DEFAULT 'whatsapp' NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "consents_tenant_phone_channel_idx" ON "consents" USING btree ("tenant_id","phone","channel");--> statement-breakpoint
CREATE INDEX "consents_tenant_channel_granted_idx" ON "consents" USING btree ("tenant_id","channel","granted");