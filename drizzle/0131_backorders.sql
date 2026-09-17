-- === W43 fulfillment (Coder A): backorders ===============================
-- ADDITIVE ONLY (hand-written, journaled after 0130; idx 0131 per SPEC_W43).
--
-- tenants.allowBackorders (default false): when stock is insufficient at
-- confirm, an order line may be marked 'backordered' (additive order_items
-- status) instead of blocking checkout. backorder_requests tracks the open
-- demand; on inventory restock the open requests for that SKU are auto-filled
-- oldest-first within the same transaction and the customer is notified via
-- channelSender/notifyCustomer category 'backorder_filled' (both channels).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "allowBackorders" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "status" varchar(16) DEFAULT 'ordered' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_status_chk";
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_status_chk" CHECK ("status" IN ('ordered','backordered'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backorder_requests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderLineId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"qty" integer NOT NULL,
	"filledQty" integer DEFAULT 0 NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"filledAt" timestamp,
	CONSTRAINT "backorder_requests_qty_chk" CHECK ("qty" > 0),
	CONSTRAINT "backorder_requests_status_chk" CHECK ("status" IN ('open','partially_filled','filled','cancelled')),
	CONSTRAINT "backorder_requests_line_fk" FOREIGN KEY ("orderLineId") REFERENCES "public"."order_items"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backorder_requests_tenant_product_idx" ON "backorder_requests" USING btree ("tenantId","productId","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backorder_requests_line_idx" ON "backorder_requests" USING btree ("orderLineId");
--> statement-breakpoint
-- At most ONE open/partially-filled request per order line (idempotent
-- backorder creation on checkout retry).
CREATE UNIQUE INDEX IF NOT EXISTS "backorder_requests_open_line_idx" ON "backorder_requests" USING btree ("orderLineId") WHERE "status" IN ('open','partially_filled');
