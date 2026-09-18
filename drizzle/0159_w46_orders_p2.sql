-- === W46 orders-p2 (Coder G) ===
-- ORD-19: purchase_orders promised-date tracking — approved_at (approval
-- instant), promised_date (approved_at + supplier lead_time_days snapshot),
-- breach_alerted_at (claim-first exactly-once breach-alert marker). The
-- breach sweep (server/services/procurement/poBreach.ts) scans
-- promised_date < now() on unfulfilled POs. ADDITIVE ONLY.
-- ORD-22: product_recalls + recall_recipients — targeted recall broadcast
-- with durable per-buyer opt-out logging (skipped_opt_out rows).
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "promised_date" timestamp;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "breach_alerted_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_promised_idx" ON "purchase_orders" USING btree ("promised_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_recalls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"reason" text NOT NULL,
	"from_date" timestamp,
	"to_date" timestamp,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recall_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recall_id" uuid NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"phone" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"channel" varchar(16),
	"error" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_recipients" ADD CONSTRAINT "recall_recipients_recall_id_product_recalls_id_fk" FOREIGN KEY ("recall_id") REFERENCES "public"."product_recalls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recall_recipients_recall_order_uniq" ON "recall_recipients" USING btree ("recall_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recall_recipients_recall_idx" ON "recall_recipients" USING btree ("recall_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recall_recipients_tenant_idx" ON "recall_recipients" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_recalls_tenant_idx" ON "product_recalls" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_recalls_product_idx" ON "product_recalls" USING btree ("tenant_id","product_id");
