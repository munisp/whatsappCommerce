-- === W46 uc-money (Coder C): UC-26 order amendments (audit trail) ===
-- ADDITIVE ONLY (hand-written; chained after 0152).
--
-- order_amendments: append-only audit trail for PRE-CONFIRMATION order
-- amendments initiated in chat (BOTH channels). amendOrder claims the order
-- row FOR UPDATE, recomputes totals in integer minor units via
-- shared/escrowAmounts (toMinorUnitsExact), then either mints a DELTA
-- payment link (delta > 0, existing paymentIntents + initiateWithFallback
-- chain, idempotency key amend-delta:<amendmentId>) or issues a partial
-- refund for the negative delta via payments/refunds.executeProviderRefund.
CREATE TABLE IF NOT EXISTS "order_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"prev_total_cents" integer NOT NULL,
	"new_total_cents" integer NOT NULL,
	"delta_cents" integer NOT NULL,
	"items" jsonb NOT NULL,
	"reason" text,
	"status" varchar(24) DEFAULT 'applied' NOT NULL,
	"payment_intent_id" varchar(36),
	"actor" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_amendments_tenant_order_idx" ON "order_amendments" USING btree ("tenant_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_amendments_tenant_created_idx" ON "order_amendments" USING btree ("tenant_id","created_at");
