-- === W44 deposits-subs-digital (Coder C): PIN digital goods ===
-- ADDITIVE ONLY (hand-written; chained after 0141).
--
-- digital_pin_batches / digital_pins: merchant bulk-uploads PIN codes for a
-- digital product (tRPC); every PIN is encrypted at rest with the W42
-- keyring v2:<kid> envelope (crypto/secrets.ts encryptSecret) and decrypted
-- SERVER-SIDE ONLY at delivery. Allocation on a paid order is claim-first
-- (UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)); delivery
-- goes to the buyer on BOTH channels via channelParity; "reveal my pin"
-- re-sends the SAME pin and writes an audit row every time. When available
-- stock for a product drops below the low-stock threshold (10) the merchant
-- gets an ops alert; an out-of-stock paid line follows the W43 backorder
-- path when tenants.allowBackorders is on (otherwise the merchant is
-- alerted that fulfillment is blocked).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "digitalPinEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digital_pin_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"uploaded_by" varchar(64) NOT NULL,
	"pin_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_pin_batches_tenant_product_idx" ON "digital_pin_batches" USING btree ("tenant_id","product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digital_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"pin_encrypted" text NOT NULL,
	"status" varchar(16) DEFAULT 'available' NOT NULL,
	"order_line_id" varchar(36),
	"order_id" varchar(36),
	"sold_at" timestamp,
	"revealed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_pins_batch_idx" ON "digital_pins" USING btree ("batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_pins_tenant_status_idx" ON "digital_pins" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_pins_available_idx" ON "digital_pins" USING btree ("tenant_id","product_id") WHERE "status" = 'available';
