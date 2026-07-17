CREATE TABLE "whatsapp_customer_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"order_id" text,
	"user_id" integer,
	"from_phone" text NOT NULL,
	"to_phone" text,
	"wamid" text NOT NULL,
	"context_wamid" text,
	"message_type" text DEFAULT 'text' NOT NULL,
	"body" text,
	"media_id" text,
	"media_url" text,
	"sentiment" text,
	"read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_customer_replies_wamid_unique" UNIQUE("wamid")
);
--> statement-breakpoint
CREATE INDEX "wacr_from_phone_idx" ON "whatsapp_customer_replies" USING btree ("from_phone");--> statement-breakpoint
CREATE INDEX "wacr_order_id_idx" ON "whatsapp_customer_replies" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "wacr_user_id_idx" ON "whatsapp_customer_replies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wacr_context_wamid_idx" ON "whatsapp_customer_replies" USING btree ("context_wamid");