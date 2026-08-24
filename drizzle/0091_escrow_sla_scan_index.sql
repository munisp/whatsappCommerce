-- W30 (Coder B): composite index backing the SLA scan / escrow auto-confirm
-- cron selection (state + buyer_confirm_deadline) now that runSlaScan also
-- joins order status per escrow. Additive only.
CREATE INDEX IF NOT EXISTS "escrow_state_deadline_idx" ON "escrow_transactions" USING btree ("state","buyer_confirm_deadline");
