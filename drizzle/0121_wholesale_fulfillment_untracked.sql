-- W38 ORD-5: wholesale stock guard — orders whose listing stock could not be
-- verified at placement are explicitly flagged (never a silent oversell).
ALTER TABLE "wholesale_orders" ADD COLUMN "fulfillment_untracked" boolean DEFAULT false NOT NULL;
