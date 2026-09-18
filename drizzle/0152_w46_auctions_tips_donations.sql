-- === W46 uc-money (Coder C): UC-11 auctions + UC-15 tipping + UC-16 donations ===
-- ADDITIVE ONLY (hand-written; chained after 0151).
--
-- auctions / auction_bids: chat-run auctions (BOTH channels). Bidding is
-- claim-first: placeBid SELECTs the auction row FOR UPDATE inside a
-- transaction and then applies a GUARDED high-bid UPDATE
-- (WHERE current_bid_cents IS NULL OR current_bid_cents < new) so a
-- concurrent same-price bid can never double-claim the high slot.
-- The close sweep (claim-first active→closed flip) invoices the winner via
-- the EXISTING paymentIntents + initiateWithFallback chain (idempotency key
-- auction-checkout:<auctionId>).
--
-- orders.tipCents: buyer-granted tip (integer minor units), included in the
-- order total BEFORE payment so the W30 escrow hold/release passes it
-- through to the merchant unchanged (escrow amount IS the verified payment).
--
-- products.openAmountEnabled + donationMinCents: pay-what-you-want /
-- donation products; the buyer enters the amount, donationMinCents is the
-- floor guard (falls back to minPriceCents when set, else any positive).
CREATE TABLE IF NOT EXISTS "auctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"title" varchar(255),
	"start_price_cents" integer NOT NULL,
	"min_increment_cents" integer DEFAULT 100 NOT NULL,
	"reserve_cents" integer,
	"anti_snipe_seconds" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"current_bid_cents" integer,
	"current_bidder_id" varchar(64),
	"bid_count" integer DEFAULT 0 NOT NULL,
	"winner_order_id" varchar(36),
	"ends_at" timestamp NOT NULL,
	"created_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auction_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"auction_id" uuid NOT NULL,
	"bidder_id" varchar(64) NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auctions_tenant_status_ends_idx" ON "auctions" USING btree ("tenant_id","status","ends_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auctions_tenant_product_idx" ON "auctions" USING btree ("tenant_id","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auction_bids_auction_amount_idx" ON "auction_bids" USING btree ("auction_id","amount_cents");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auction_bids_tenant_bidder_idx" ON "auction_bids" USING btree ("tenant_id","bidder_id");
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tipCents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "openAmountEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "donationMinCents" integer;
