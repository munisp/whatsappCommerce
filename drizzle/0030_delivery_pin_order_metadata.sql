-- ============================================================
-- Migration 0030: WhatsApp customer-journey parity
-- 1. logistics_shipments.delivery_pin — 4-digit handover PIN the rider
--    collects from the buyer at delivery (see logistics.createShipment /
--    logistics.simulateDelivery).
-- 2. orders.metadata — structured order extras: fulfillment choice,
--    subtotal/deliveryFee breakdown, receipt-review flag.
-- Both statements are idempotent.
-- ============================================================

ALTER TABLE "logistics_shipments" ADD COLUMN IF NOT EXISTS "delivery_pin" varchar(8);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
