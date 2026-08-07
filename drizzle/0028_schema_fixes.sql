-- ============================================================
-- Migration 0028: Schema fixes & missing index backfill
-- 1. Unique indexes declared in schema.ts but never migrated
-- 2. Missing FK whatsapp_media_files."tenantId" -> tenants.id
-- 3. Missing indexes on high-traffic tables (schema.ts parity)
-- All statements are idempotent.
-- ============================================================

-- ── 1. Unique indexes declared in schema.ts ──────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "tb_accounts_tb_id_idx" ON "tigerbeetle_accounts" USING btree ("tb_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apisix_routes_route_id_idx" ON "apisix_route_configs" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_media_conversation_idx" ON "whatsapp_media_files" USING btree ("conversationId");--> statement-breakpoint

-- ── 2. Missing FK on whatsapp_media_files."tenantId" (declared in schema.ts,
--       never emitted by migration 0008) ──────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "whatsapp_media_files"
    ADD CONSTRAINT "whatsapp_media_files_tenantId_tenants_id_fk"
    FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ── 3. High-traffic table indexes (schema.ts parity) ─────────────────────────
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_product_idx" ON "order_items" USING btree ("productId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_items_session_idx" ON "cart_items" USING btree ("cartSessionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_sessions_tenant_idx" ON "cart_sessions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_sessions_phone_idx" ON "cart_sessions" USING btree ("waPhoneNumber");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_sessions_customer_idx" ON "cart_sessions" USING btree ("customerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nlp_sessions_tenant_idx" ON "nlp_sessions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nlp_sessions_phone_idx" ON "nlp_sessions" USING btree ("waPhoneNumber");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_tenant_idx" ON "users" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_tenant_idx" ON "channel_messages" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_channel_idx" ON "channel_messages" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_created_idx" ON "channel_messages" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_idx" ON "invoices" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_order_idx" ON "refunds" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_tenant_idx" ON "refunds" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mobile_money_tenant_idx" ON "mobile_money_transactions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mobile_money_status_idx" ON "mobile_money_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mobile_money_extref_idx" ON "mobile_money_transactions" USING btree ("externalRef");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mobile_money_order_idx" ON "mobile_money_transactions" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_tenant_idx" ON "appointments" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_status_idx" ON "appointments" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_customer_phone_idx" ON "appointments" USING btree ("customerPhone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_commissions_seller_idx" ON "marketplace_commissions" USING btree ("sellerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_commissions_order_idx" ON "marketplace_commissions" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_commissions_status_idx" ON "marketplace_commissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_products_seller_idx" ON "seller_products" USING btree ("sellerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_products_tenant_idx" ON "seller_products" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_sellers_tenant_idx" ON "marketplace_sellers" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_sellers_status_idx" ON "marketplace_sellers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_sellers_owner_phone_idx" ON "marketplace_sellers" USING btree ("ownerPhone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_tiers_product_idx" ON "wholesale_price_tiers" USING btree ("productId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_tiers_tenant_idx" ON "wholesale_price_tiers" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dpp_product_idx" ON "digital_product_purchases" USING btree ("productId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dpp_customer_phone_idx" ON "digital_product_purchases" USING btree ("customerPhone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "b2b_rfq_tenant_idx" ON "b2b_rfq" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "b2b_rfq_status_idx" ON "b2b_rfq" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "b2b_rfq_buyer_phone_idx" ON "b2b_rfq" USING btree ("buyerPhone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "b2b_po_tenant_idx" ON "b2b_purchase_orders" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "b2b_po_status_idx" ON "b2b_purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ussd_sessions_phone_idx" ON "ussd_sessions" USING btree ("phoneNumber");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "temporal_runs_run_id_idx" ON "temporal_workflow_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hermes_configs_tenant_idx" ON "hermes_configs" USING btree ("tenantId");
