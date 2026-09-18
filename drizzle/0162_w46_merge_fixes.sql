-- === W46 merger fixes ===
-- TEN-9 (Coder A) widened tenant_memberships.role at the TYPE level
-- (owner|operator|analyst|finance|catalog) but the legacy CHECK constraint
-- from mig 0049 still restricted the DB to ('owner','operator','analyst'),
-- so finance/catalog membership inserts violated it (A's J389). Widen the
-- constraint to the full capability-model role set. Constraint swap only —
-- no columns touched.
ALTER TABLE "tenant_memberships" DROP CONSTRAINT IF EXISTS "tenant_memberships_role_check";
--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_check" CHECK ("role" IN ('owner','operator','analyst','finance','catalog'));
