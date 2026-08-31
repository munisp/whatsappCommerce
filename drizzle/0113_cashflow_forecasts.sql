-- W33 ai-qa-forecast (Coder B): honest cash-flow forecast snapshots.
-- One row per (tenant, horizon, day): the latest computed 30/60/90-day
-- projection from REAL scheduled outflows (scheduled_payments, recurring_rules
-- next occurrences, installment due dates, vendor_bills due dates) and inflows
-- (expected escrow releases by buyer-confirm deadline, AR invoice due dates,
-- labelled historical paid-invoice velocity heuristic). Written only by
-- server/services/cashflowForecast.ts from a real computation — never
-- hand-seeded. detail jsonb carries the per-line sources so
-- sum(lines) == inflow_cents / outflow_cents (auditable conservation).
-- Idempotent: the UNIQUE expression index on (tenant_id, horizon_days,
-- generated_at::date) makes a same-day recompute a no-op (the service also
-- skips the insert when today's snapshot already exists).
CREATE TABLE IF NOT EXISTS "cashflow_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"horizon_days" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inflow_cents" bigint NOT NULL,
	"outflow_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"shortfall_at" date,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cashflow_forecasts_tenant_idx" ON "cashflow_forecasts" USING btree ("tenant_id","generated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_forecasts_tenant_horizon_day_uniq" ON "cashflow_forecasts" USING btree ("tenant_id","horizon_days",(("generated_at" AT TIME ZONE 'UTC')::date));
