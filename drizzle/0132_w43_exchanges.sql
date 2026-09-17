-- W43 (Coder B): exchanges + stock-adjustment audit — ADDITIVE ONLY
-- (hand-written; idx 0132-0133 per SPEC_W43 Coder B range, journal chained
-- from the 0129 tip; merger re-chains against Coder A's 0130-0131).
--
-- exchange_requests: swap one order line for another product with a real
-- state machine:
--   requested → approved | rejected | cancelled
--   approved  → in_transit → received → completed
-- Money leg: positive priceDeltaCents → payment link (existing payment
-- intent path); negative → customerWallet.creditWallet (W41 contract).
-- Stock leg (on 'received'): fromLine restocked (or written off when the
-- returned goods are damaged) + toLine stock reserved claim-first.
CREATE TABLE IF NOT EXISTS "exchange_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"rma_request_id" uuid,
	"from_order_line_id" varchar(36) NOT NULL,
	"to_product_id" varchar(36) NOT NULL,
	"to_variant_id" varchar(36),
	"qty" integer NOT NULL,
	"price_delta_cents" bigint DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'requested' NOT NULL,
	"requested_by" varchar(64) NOT NULL,
	"requested_via" varchar(16) DEFAULT 'admin' NOT NULL,
	"damaged" boolean DEFAULT false NOT NULL,
	"payment_intent_id" varchar(36),
	"wallet_entry_ref" varchar(128),
	"merchant_note" text,
	"decided_at" timestamp,
	"in_transit_at" timestamp,
	"received_at" timestamp,
	"completed_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_status_chk" CHECK ("status" IN ('requested','approved','rejected','in_transit','received','completed','cancelled')),
	CONSTRAINT "exchange_qty_pos_chk" CHECK ("qty" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchange_requests_tenant_order_idx" ON "exchange_requests" USING btree ("tenant_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchange_requests_tenant_status_idx" ON "exchange_requests" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchange_requests_from_line_idx" ON "exchange_requests" USING btree ("tenant_id","from_order_line_id");
