-- W30 (Coder C): feature-ring money truth — uniqueness backstops.
-- Additive only; hand-written (drizzle-kit broken). Evidence:
--   V3#9  loyalty ledger has no dup backstop (tenant, phone, order, kind)
--   V3#12 marketplace commissions client-supplied, no orderId dedupe
--   V3#13 float income double-accrues on repeat runs (date not unique)
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_ledger_tenant_phone_order_kind_uniq" ON "loyalty_ledger" USING btree ("tenant_id","customer_phone","order_id","entry_type") WHERE "order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_commissions_order_uniq" ON "marketplace_commissions" USING btree ("orderId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "float_income_date_uniq" ON "float_income_entries" USING btree ("date");
