-- W18: risk-based terms (server/services/tradeCredit/terms.ts).
-- Additive-only, idempotent: fee_bps snapshots the facility fee (basis
-- points) at approval; NULL for pre-W18 facilities (no fee).
ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "fee_bps" integer;
