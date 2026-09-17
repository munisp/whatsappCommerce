-- === W43 fulfillment (Coder A): partial fulfillment ======================
-- ADDITIVE ONLY (hand-written, journaled after 0129; idx 0130 per SPEC_W43).
--
-- order_fulfillments + order_fulfillment_lines: merchants can fulfill a
-- subset of order lines. Fulfillment is claim-first (order lines locked FOR
-- UPDATE inside the txn) and idempotent (fulfillment-line unique key =
-- fulfillmentId + orderLineId). Fulfilling consumes the COMMITTED stock
-- reservation exactly once (stock left the building at reserve time; the
-- reservation ledger is decremented, never restocked).
--
-- orders.status gains the additive enum value 'partially_fulfilled' (some
-- but not all lines fulfilled). inventory_reservations.status gains the
-- additive CHECK value 'fulfilled' for fully-consumed committed rows.
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'partially_fulfilled';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_fulfillments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"trackingCarrier" varchar(64),
	"trackingNumber" varchar(128),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "order_fulfillments_status_chk" CHECK ("status" IN ('pending','partial','complete','cancelled')),
	CONSTRAINT "order_fulfillments_order_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_fulfillment_lines" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"fulfillmentId" varchar(36) NOT NULL,
	"orderLineId" varchar(36) NOT NULL,
	"qty" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "order_fulfillment_lines_qty_chk" CHECK ("qty" > 0),
	CONSTRAINT "ofl_fulfillment_fk" FOREIGN KEY ("fulfillmentId") REFERENCES "public"."order_fulfillments"("id") ON DELETE cascade,
	CONSTRAINT "ofl_order_line_fk" FOREIGN KEY ("orderLineId") REFERENCES "public"."order_items"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_fulfillments_tenant_idx" ON "order_fulfillments" USING btree ("tenantId","orderId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ofl_line_idx" ON "order_fulfillment_lines" USING btree ("orderLineId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ofl_idem_idx" ON "order_fulfillment_lines" USING btree ("fulfillmentId","orderLineId");
--> statement-breakpoint
ALTER TABLE "inventory_reservations" DROP CONSTRAINT IF EXISTS "inventory_reservations_status_check";
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_status_check" CHECK ("status" IN ('reserved','committed','released','fulfilled'));
