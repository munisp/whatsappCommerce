-- === W46 uc-ux (Coder E): UC-24 gift orders + UC-21 slot link + UC-27 min order ===
-- ADDITIVE ONLY (hand-written; chained after 0155).
--
-- UC-24: gift orders on the ORDER level (shipments already carry recipient
-- fields; orders did not). isGift/giftMessage/giftRecipientPhone drive the
-- price-hidden gift receipt; giftWrapFeeCents records the gift-wrap fee
-- line actually charged on this order (0 = no wrap).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "isGift" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "giftMessage" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "giftRecipientPhone" varchar(30);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "giftWrapFeeCents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- UC-21: the delivery slot this order booked (capacity claimed at checkout).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliverySlotId" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_delivery_slot_idx" ON "orders" USING btree ("deliverySlotId");
--> statement-breakpoint
-- UC-27: per-tenant minimum order value (integer cents) per fulfillment
-- mode; 0 = no minimum. Checkout blocks/prompts below the minimum on BOTH
-- channels (server/services/minOrder.ts).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "minOrderCentsDelivery" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "minOrderCentsPickup" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- UC-24: tenant-configured gift-wrap fee (integer cents); 0 = wrap free/off.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "giftWrapFeeCents" integer DEFAULT 0 NOT NULL;
