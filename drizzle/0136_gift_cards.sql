-- === W44 giftcards-referrals (Coder A): gift cards ===
-- ADDITIVE ONLY (hand-written; chained after 0135).
--
-- gift_cards: purchasable/merchant-issued stored-value cards. Integer cents
-- (kobo) balances; redemption is claim-first (SELECT ... FOR UPDATE +
-- guarded UPDATE balance_cents >= amount) so concurrent redeems can never
-- overdraw. Code is unique per tenant.
-- gift_card_transactions: append-only audit rail; idempotency_key UNIQUE is
-- the exactly-once claim for purchase/redemption/adjustment retries.
CREATE TABLE IF NOT EXISTS "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"code" varchar(64) NOT NULL,
	"initial_balance_cents" integer NOT NULL,
	"balance_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"purchaser_customer_id" varchar(64),
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_balance_nonnegative" CHECK ("balance_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gift_cards_tenant_code_uidx" ON "gift_cards" USING btree ("tenant_id","code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gift_cards_tenant_status_idx" ON "gift_cards" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gift_card_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"type" varchar(16) NOT NULL,
	"amount_cents" integer NOT NULL,
	"order_id" varchar(64),
	"idempotency_key" varchar(160) NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gift_card_tx_idempotency_uidx" ON "gift_card_transactions" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gift_card_tx_card_idx" ON "gift_card_transactions" USING btree ("gift_card_id","created_at");
