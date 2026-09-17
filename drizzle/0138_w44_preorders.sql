-- === W44 preorders-offers (Coder B): pre-orders ===
-- ADDITIVE ONLY (hand-written; chained after 0135 — 0136/0137 belong to
-- Coder A and are merged separately).
--
-- Pre-orders: a product with preorderEnabled=TRUE and preorderAvailableAt in
-- the future can be checked out before availability; its order lines are
-- marked 'preorder' (order_items.status vocabulary extension — the column is
-- varchar(16) since W43, no enum change required). tenants.preorderDepositPct
-- (integer 0-100, default 100 = full capture) records the deposit policy.
-- When availableAt is reached the lazy sweeper (existing CronJob pattern,
-- /api/scheduled/preorders-due) flips lines to 'ordered' so the W43
-- fulfillment/backorder paths take over unchanged; cancelling a pre-order
-- before availability refunds in full via the existing escrow/provider
-- refund path.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "preorderEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "preorderAvailableAt" timestamp;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "preorderDepositPct" integer DEFAULT 100 NOT NULL;
--> statement-breakpoint
-- 0-100 guard (additive CHECK; 100 = full capture, <100 = deposit-only).
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_preorder_deposit_pct_range" CHECK ("preorderDepositPct" >= 0 AND "preorderDepositPct" <= 100) NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_preorder_idx" ON "products" USING btree ("tenantId","preorderEnabled","preorderAvailableAt");
--> statement-breakpoint
-- order_items.status vocabulary extension: 'preorder' joins the W43
-- 'ordered'|'backordered' CHECK (varchar(16) column, mig 0131).
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_status_chk";
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_status_chk" CHECK ("status" IN ('ordered','backordered','preorder'));
