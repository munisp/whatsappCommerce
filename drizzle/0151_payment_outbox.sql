-- === W45 money-ledger (Coder B3): payment_outbox ===
-- ADDITIVE ONLY (hand-written; chained after 0142).
--
-- Transactional outbox for post-commit external money legs (PAY-16 FX
-- Mojaloop transfer initiation, PAY-18 PoT TigerBeetle transfers). The PG
-- money mutation and the outbox row commit atomically; the
-- processPaymentOutbox worker delivers the external leg asynchronously with
-- bounded retry. Exactly-once via the deterministic unique `reference`;
-- claim-first pending→delivering flip prevents concurrent double-delivery;
-- stale 'delivering' rows (crash mid-delivery) are reaped to 'pending'.
CREATE TABLE IF NOT EXISTS "payment_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"reference" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_outbox_reference_uniq" ON "payment_outbox" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_outbox_status_created_idx" ON "payment_outbox" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_outbox_tenant_idx" ON "payment_outbox" USING btree ("tenant_id");
--> statement-breakpoint
-- PAY-16 compensating re-credit leg type for aborted FX deliveries.
ALTER TYPE "public"."wallet_tx_type" ADD VALUE IF NOT EXISTS 'fx_refund';
