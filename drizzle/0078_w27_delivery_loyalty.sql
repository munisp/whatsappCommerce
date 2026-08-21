-- W27 (Coder E): delivery aggregation + loyalty points.
-- courier_configs: per-tenant courier adapter enablement (registry pattern
--   mirrors payment_gateway_configs).
-- deliveries: aggregated dispatch bookings; fee_cents is INTEGER CENTS added
--   to the order total at checkout; status lifecycle
--   quoted|booked|picked_up|in_transit|delivered|failed|cancelled.
-- loyalty_rules: per-tenant earn/burn rules (1 row per tenant).
-- loyalty_ledger: double-entry-style points ledger (debit/credit accounts).
-- Additive only.
CREATE TABLE IF NOT EXISTS "courier_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"courier" varchar(50) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"credentials" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "courier_configs_tenant_courier_idx" ON "courier_configs" ("tenant_id","courier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_configs_tenant_idx" ON "courier_configs" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"courier" varchar(50) NOT NULL,
	"external_id" varchar(128),
	"status" varchar(24) DEFAULT 'quoted' NOT NULL,
	"fee_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"distance_km" numeric(8, 3),
	"quote" jsonb,
	"pickup_address" jsonb,
	"dropoff_address" jsonb,
	"recipient_phone" varchar(30),
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booked_at" timestamp,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_tenant_idx" ON "deliveries" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_order_idx" ON "deliveries" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_status_idx" ON "deliveries" ("tenant_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"points_per_unit" integer DEFAULT 1 NOT NULL,
	"unit_value_cents" integer DEFAULT 10000 NOT NULL,
	"points_value_cents" integer DEFAULT 100 NOT NULL,
	"redemption_cap_percent" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_rules_tenant_idx" ON "loyalty_rules" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_phone" varchar(30) NOT NULL,
	"entry_type" varchar(16) NOT NULL,
	"points" integer NOT NULL,
	"debit_account" varchar(96) NOT NULL,
	"credit_account" varchar(96) NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" varchar(255) NOT NULL,
	"order_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_ledger_tenant_idx" ON "loyalty_ledger" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_ledger_customer_idx" ON "loyalty_ledger" ("tenant_id","customer_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_ledger_order_idx" ON "loyalty_ledger" ("order_id");
