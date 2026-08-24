-- W30 (Coder A / loans-credit): double-disburse race backstop (verify-v1 #3).
-- At most ONE open loan per (tenant, merchant). 'active' = disbursed and
-- accruing; 'disbursed' is included defensively for any rows written by
-- out-of-band tooling in that state. Partial unique index so repaid /
-- defaulted / cancelled history is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_loans_open_uniq"
	ON "merchant_loans" USING btree ("tenant_id","merchant_id")
	WHERE "status" IN ('active','disbursed');
