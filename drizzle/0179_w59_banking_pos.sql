-- === W59 banking-pos: merchant payout accounts (verified multi-account
-- withdrawals), agent cash-in/cash-out ledger, POS terminal registry and POS
-- payment sessions, plus agent banking config on escrow_config and the
-- 'agent_cico' wallet transaction type. Additive-only; IF NOT EXISTS /
-- IF NOT EXISTS-index for idempotent re-application; enum value appended
-- (never reorder existing wallet_tx_type values). ===
ALTER TYPE "public"."wallet_tx_type" ADD VALUE IF NOT EXISTS 'agent_cico';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"walletId" varchar(36) NOT NULL,
	"bankCode" varchar(10) NOT NULL,
	"accountNumber" varchar(20) NOT NULL,
	"accountName" varchar(255) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"label" varchar(64),
	"isPrimary" boolean DEFAULT false NOT NULL,
	"verifiedAt" timestamp DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_payout_accounts_wallet_provider_account_uniq" ON "merchant_payout_accounts" ("walletId", "provider", "accountNumber");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_payout_accounts_tenant_idx" ON "merchant_payout_accounts" ("tenantId", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_payout_accounts_wallet_idx" ON "merchant_payout_accounts" ("walletId", "isPrimary");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_cico_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentTenantId" varchar(36) NOT NULL,
	"customerPhone" varchar(32) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"amountCents" integer NOT NULL,
	"feeCents" integer DEFAULT 0 NOT NULL,
	"commissionCents" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reference" varchar(64) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_cico_transactions_ref_uniq" ON "agent_cico_transactions" ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cico_transactions_agent_idx" ON "agent_cico_transactions" ("agentTenantId", "createdAt");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_pos_terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"terminalRef" varchar(64) NOT NULL,
	"label" varchar(64),
	"storeLocation" varchar(255),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_pos_terminals_ref_uniq" ON "merchant_pos_terminals" ("tenantId", "provider", "terminalRef");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_pos_terminals_tenant_idx" ON "merchant_pos_terminals" ("tenantId", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_payment_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderId" varchar(36),
	"amountCents" integer NOT NULL,
	"reference" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'awaiting' NOT NULL,
	"channel" varchar(16) NOT NULL,
	"terminalId" uuid,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_payment_sessions_ref_uniq" ON "pos_payment_sessions" ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_payment_sessions_tenant_idx" ON "pos_payment_sessions" ("tenantId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_payment_sessions_expiry_idx" ON "pos_payment_sessions" ("status", "expiresAt");
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "agent_commission_bps" integer DEFAULT 100 NOT NULL;
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "agent_float_alert_threshold_cents" integer DEFAULT 1000000 NOT NULL;
