-- === W46 uc-ux (Coder E): UC-17 venue tables, UC-21 delivery slots, UC-23 wishlists ===
-- ADDITIVE ONLY (hand-written; chained after 0151).
--
-- UC-17: venue_tables — a physical table/seat in a venue (restaurant,
-- food-truck, market stall). Each row carries a capability `qr_token`
-- printed on the table QR; scanning it deep-links the buyer into chat with
-- a prefilled `TABLE:<token>` message that seeds the cart session metadata
-- (server/services/venueTables.ts). The kitchen board view is derived from
-- orders whose metadata carries the venue table.
CREATE TABLE IF NOT EXISTS "venue_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"label" varchar(80) NOT NULL,
	"qr_token" varchar(128) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "venue_tables_tenant_token_uq" ON "venue_tables" USING btree ("tenant_id","qr_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "venue_tables_tenant_idx" ON "venue_tables" USING btree ("tenant_id");
--> statement-breakpoint
-- UC-21: delivery_slots — per-tenant delivery window with a hard capacity.
-- Bookings are claimed with a guarded UPDATE (booked_count < capacity) so
-- two concurrent checkouts can never oversell the slot; orders.deliverySlotId
-- (0156) records the booked slot.
CREATE TABLE IF NOT EXISTS "delivery_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"slot_date" date NOT NULL,
	"start_time" varchar(8) NOT NULL,
	"end_time" varchar(8) NOT NULL,
	"capacity" integer NOT NULL,
	"booked_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_slots_tenant_date_idx" ON "delivery_slots" USING btree ("tenant_id","slot_date");
--> statement-breakpoint
-- UC-23: wishlists — "save this" / "my list" buyer wishlist rows. The
-- price-drop sweep (sweepWishlistPriceDrops) compares the CURRENT product
-- price to last_price_cents and notifies once per drop (notified_at).
CREATE TABLE IF NOT EXISTS "wishlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"last_price_cents" integer,
	"notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wishlists_tenant_phone_product_uq" ON "wishlists" USING btree ("tenant_id","phone","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wishlists_tenant_idx" ON "wishlists" USING btree ("tenant_id");
