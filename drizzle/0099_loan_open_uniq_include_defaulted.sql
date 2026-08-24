-- W30 hotfix seam: a DEFAULTED loan must also block new offers (J141).
-- Hotfix-money aligned the app-level checks to the 0088 index set
-- ('active','disbursed'), which inadvertently let defaulted merchants
-- re-borrow. Widen the open-loan set to include 'defaulted' and align the
-- app checks to exactly this set. Drop + recreate (partial index predicate
-- cannot be altered in place).
DROP INDEX IF EXISTS "merchant_loans_open_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_loans_open_uniq"
	ON "merchant_loans" USING btree ("tenant_id","merchant_id")
	WHERE "status" IN ('active','disbursed','defaulted');
