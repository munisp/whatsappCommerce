-- W32 earlypay-fx (Coder C): early-payment discount terms on wholesale
-- purchase orders. Additive-only. The supplier (wholesale_orders.tenant_id)
-- configures discount_bps + discount_window_days + due_date; the app derives
-- early_pay_deadline = MIN(due_date, created_at + discount_window_days).
-- discount_applied is the claim-first guard: the earlyPay path flips it via
-- a guarded conditional UPDATE (status IN ('pending','confirmed') AND NOT
-- discount_applied AND early_pay_deadline > now()) BEFORE any money moves,
-- so a double-tap can never double-discount. discount_cents records the
-- integer-cents saving actually applied (NULL until an early pay lands).
ALTER TABLE "wholesale_orders" ADD COLUMN IF NOT EXISTS "discount_bps" integer;
--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD COLUMN IF NOT EXISTS "discount_window_days" integer;
--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD COLUMN IF NOT EXISTS "due_date" timestamp;
--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD COLUMN IF NOT EXISTS "early_pay_deadline" timestamp;
--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD COLUMN IF NOT EXISTS "discount_applied" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD COLUMN IF NOT EXISTS "discount_cents" bigint;
--> statement-breakpoint
-- wallet_tx_type enum has no wholesale-trade value (additive-only schema
-- doctrine): early-pay debits/credits are typed 'wholesale_trade' with the
-- reference `earlypay:<orderId>` (+ ':supplier' on the credit leg).
ALTER TYPE "wallet_tx_type" ADD VALUE IF NOT EXISTS 'wholesale_trade';
