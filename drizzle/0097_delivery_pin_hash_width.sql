-- W30 merger seam fix (V3#17): D stores the delivery PIN as a keyed
-- HMAC-SHA256 hash ("pinv1:" + 64 hex = 70 chars) but the column was still
-- varchar(8) from 0030 — every createShipment insert failed. Widen it.
ALTER TABLE "logistics_shipments" ALTER COLUMN "delivery_pin" SET DATA TYPE varchar(80);
