-- W17/F10 (J88–J90): COD + offline-trade flow depth.
-- Additive-only and idempotent (IF NOT EXISTS / ADD VALUE IF NOT EXISTS):
--   - orders.codState varchar(32) NULL (COD state machine; NULL = non-COD)
--   - cod_events append-only transition audit table
--   - partial unique indexes enforce funds-critical idempotency:
--       * at most one 'cash_collected' and one 'settled' event per order
--       * at most one payment_transactions row per COD claim providerRef
--   - merchant notification types for COD discrepancy / delivery failure
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codState" varchar(32);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_cod_state_idx" ON "orders" USING btree ("tenantId","codState");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cod_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"fromState" varchar(32),
	"toState" varchar(32) NOT NULL,
	"actor" varchar(128) NOT NULL,
	"note" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cod_events_tenant_idx" ON "cod_events" USING btree ("tenantId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cod_events_order_idx" ON "cod_events" USING btree ("orderId");
--> statement-breakpoint
-- Settlement idempotency claims (claim-first; replay = no-op read-back).
CREATE UNIQUE INDEX IF NOT EXISTS "cod_events_collected_uq" ON "cod_events" USING btree ("tenantId","orderId") WHERE "toState" = 'cash_collected';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cod_events_settled_uq" ON "cod_events" USING btree ("tenantId","orderId") WHERE "toState" = 'settled';
--> statement-breakpoint
-- COD cash-collection rows claim via unique providerRef (cod + offline cash).
CREATE UNIQUE INDEX IF NOT EXISTS "ptx_cod_ref_uq" ON "payment_transactions" USING btree ("providerRef") WHERE "provider" IN ('cod','offline-cash','offline-transfer') AND "providerRef" IS NOT NULL;
--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'cod_discrepancy';
--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'cod_delivery_failed';
