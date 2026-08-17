-- W14.1: exactly-once repayment per (credit_account_id, ref). Defense in
-- depth for the retrySettlement double-settle race: if the settlement_retry
-- marker persist silently fails, two concurrent admin retries with an
-- explicit amountCents could both insert a 'repayment' row and decrement
-- outstanding twice. The partial unique index makes the second insert fail
-- with 23505, which applyRepaymentTx translates into an idempotent
-- already_settled-style no-op. Scoped to kind='repayment' rows only because
-- settlement_retry markers share the table (kind='adjustment') with the
-- SAME ref.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_repayment_ref_uniq" ON "credit_ledger" USING btree ("credit_account_id","ref") WHERE kind = 'repayment' AND ref IS NOT NULL;
