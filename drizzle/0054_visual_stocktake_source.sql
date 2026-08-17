-- CV-1 (J85): WhatsApp shelf-photo stock-take.
-- Additive: capture channel on visual_inventory_sessions so WhatsApp-originated
-- stock-takes are distinguishable from dashboard ('mobile') uploads.
ALTER TABLE "visual_inventory_sessions" ADD COLUMN IF NOT EXISTS "source" varchar(32) DEFAULT 'mobile' NOT NULL;
