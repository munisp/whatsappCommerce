CREATE TYPE "public"."cogs_dispute_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."custody_mode" AS ENUM('pssp', 'psp');--> statement-breakpoint
CREATE TYPE "public"."dispute_resolution" AS ENUM('full_release_to_merchant', 'full_refund_to_buyer', 'partial_refund', 'no_action');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'under_review', 'resolved_merchant', 'resolved_buyer', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."escrow_state" AS ENUM('payment_received', 'escrow_held', 'delivery_confirmed', 'release_instructed', 'settled', 'dispute_raised', 'dispute_resolved', 'refunded', 'expired');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned');--> statement-breakpoint
CREATE TYPE "public"."wallet_tx_type" AS ENUM('escrow_credit', 'escrow_release', 'escrow_refund', 'float_income', 'withdrawal', 'fee_deduction');--> statement-breakpoint
CREATE TABLE "alert_rule_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_name" varchar(128) NOT NULL,
	"rule_type" "alert_rule_type" NOT NULL,
	"actual_value" numeric(10, 4) NOT NULL,
	"threshold" numeric(10, 4) NOT NULL,
	"window_hours" integer NOT NULL,
	"notification_sent" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"triggered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cogs_dispute_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"current_cogs_rate" numeric(5, 4) NOT NULL,
	"requested_cogs_rate" numeric(5, 4) NOT NULL,
	"justification" text,
	"status" "cogs_dispute_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" varchar(128),
	"review_note" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"custody_mode" "custody_mode" DEFAULT 'pssp' NOT NULL,
	"bank_partner_name" varchar(100),
	"bank_partner_code" varchar(20),
	"bank_api_base_url" text,
	"bank_api_key_encrypted" text,
	"bank_escrow_account_number" varchar(20),
	"shipbubble_api_key" text,
	"shipbubble_webhook_secret" text,
	"platform_fee_rate" numeric(6, 4) DEFAULT '0.03125' NOT NULL,
	"buyer_confirm_window_hours" integer DEFAULT 24 NOT NULL,
	"dispute_window_hours" integer DEFAULT 48 NOT NULL,
	"auto_confirm_enabled" boolean DEFAULT true NOT NULL,
	"float_yield_rate" numeric(6, 4) DEFAULT '0.08' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_disputes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"escrow_tx_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"raised_by" varchar(30) DEFAULT 'buyer' NOT NULL,
	"reason" varchar(100) NOT NULL,
	"description" text,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"resolution" "dispute_resolution",
	"refund_amount" numeric(14, 2),
	"buyer_evidence" jsonb,
	"merchant_evidence" jsonb,
	"resolved_by" varchar(128),
	"resolver_notes" text,
	"buyer_response_deadline" timestamp,
	"merchant_response_deadline" timestamp,
	"resolved_at" timestamp,
	"escalated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_id" varchar(36),
	"amount" numeric(14, 2) NOT NULL,
	"platform_fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_merchant_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"custody_mode" "custody_mode" DEFAULT 'pssp' NOT NULL,
	"state" "escrow_state" DEFAULT 'payment_received' NOT NULL,
	"bank_ref" varchar(128),
	"bank_hold_confirmed_at" timestamp,
	"release_instructed_at" timestamp,
	"bank_settlement_confirmed_at" timestamp,
	"buyer_wallet_tx_id" varchar(36),
	"merchant_wallet_tx_id" varchar(36),
	"shipment_id" varchar(36),
	"delivery_confirmed_at" timestamp,
	"buyer_confirmed_at" timestamp,
	"auto_confirmed" boolean DEFAULT false NOT NULL,
	"buyer_confirm_deadline" timestamp,
	"settled_at" timestamp,
	"refunded_at" timestamp,
	"idempotency_key" varchar(128),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "float_income_entries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"date" varchar(10) NOT NULL,
	"total_escrow_balance" numeric(16, 2) NOT NULL,
	"daily_yield_rate" numeric(10, 8) NOT NULL,
	"income_amount" numeric(14, 4) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_month" varchar(7) NOT NULL,
	"projected_revenue" numeric(14, 4) NOT NULL,
	"projected_gmv" numeric(14, 4) NOT NULL,
	"actual_revenue" numeric(14, 4),
	"actual_gmv" numeric(14, 4),
	"accuracy_pct" numeric(7, 4),
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logistics_shipments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"escrow_tx_id" varchar(36),
	"provider" varchar(50) DEFAULT 'shipbubble' NOT NULL,
	"carrier_id" varchar(50),
	"carrier_name" varchar(100),
	"tracking_id" varchar(128),
	"tracking_url" text,
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"sender_name" varchar(255),
	"sender_phone" varchar(30),
	"sender_address" jsonb,
	"recipient_name" varchar(255),
	"recipient_phone" varchar(30),
	"recipient_address" jsonb,
	"weight_kg" numeric(6, 2),
	"shipping_fee" numeric(10, 2),
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"estimated_delivery_at" timestamp,
	"created_at_provider" timestamp,
	"picked_up_at" timestamp,
	"in_transit_at" timestamp,
	"out_for_delivery_at" timestamp,
	"delivered_at" timestamp,
	"failed_at" timestamp,
	"returned_at" timestamp,
	"webhook_payloads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_response" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_wallets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"available_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"escrow_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_earned" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_withdrawn" numeric(14, 2) DEFAULT '0' NOT NULL,
	"custody_mode" "custody_mode" DEFAULT 'pssp' NOT NULL,
	"bank_account_name" varchar(255),
	"bank_account_number" varchar(20),
	"bank_code" varchar(10),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_wallets_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_sso_profiles" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"sso_sub" varchar(256),
	"sso_email" varchar(255),
	"sso_name" varchar(255),
	"sso_provider" varchar(64) DEFAULT 'keycloak',
	"sso_login_count" integer DEFAULT 0 NOT NULL,
	"portal_role" varchar(16) DEFAULT 'agent' NOT NULL,
	"first_sso_login_at" timestamp DEFAULT now() NOT NULL,
	"last_sso_login_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"wallet_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"type" "wallet_tx_type" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"balance_before" numeric(14, 2) NOT NULL,
	"balance_after" numeric(14, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"order_id" varchar(36),
	"escrow_tx_id" varchar(36),
	"description" text,
	"reference" varchar(128),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "cooldown_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cogsRate" real DEFAULT 0.4 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rule_events" ADD CONSTRAINT "alert_rule_events_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cogs_dispute_requests" ADD CONSTRAINT "cogs_dispute_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_disputes" ADD CONSTRAINT "escrow_disputes_escrow_tx_id_escrow_transactions_id_fk" FOREIGN KEY ("escrow_tx_id") REFERENCES "public"."escrow_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_shipments" ADD CONSTRAINT "logistics_shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_merchant_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."merchant_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_rule_events_rule_id_idx" ON "alert_rule_events" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "alert_rule_events_triggered_at_idx" ON "alert_rule_events" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX "alert_rule_events_type_idx" ON "alert_rule_events" USING btree ("rule_type");--> statement-breakpoint
CREATE INDEX "cogs_dispute_tenant_idx" ON "cogs_dispute_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cogs_dispute_status_idx" ON "cogs_dispute_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dispute_escrow_idx" ON "escrow_disputes" USING btree ("escrow_tx_id");--> statement-breakpoint
CREATE INDEX "dispute_order_idx" ON "escrow_disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "dispute_tenant_idx" ON "escrow_disputes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "dispute_status_idx" ON "escrow_disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "escrow_order_idx" ON "escrow_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "escrow_tenant_idx" ON "escrow_transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "escrow_state_idx" ON "escrow_transactions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "escrow_created_idx" ON "escrow_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "float_income_date_idx" ON "float_income_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "forecast_snapshots_month_idx" ON "forecast_snapshots" USING btree ("snapshot_month");--> statement-breakpoint
CREATE INDEX "shipment_order_idx" ON "logistics_shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipment_tenant_idx" ON "logistics_shipments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "shipment_status_idx" ON "logistics_shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipment_tracking_idx" ON "logistics_shipments" USING btree ("tracking_id");--> statement-breakpoint
CREATE INDEX "wallet_tenant_idx" ON "merchant_wallets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_sso_profiles_email_idx" ON "tenant_sso_profiles" USING btree ("sso_email");--> statement-breakpoint
CREATE INDEX "wallet_tx_wallet_idx" ON "wallet_transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "wallet_tx_tenant_idx" ON "wallet_transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "wallet_tx_type_idx" ON "wallet_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "wallet_tx_created_idx" ON "wallet_transactions" USING btree ("created_at");