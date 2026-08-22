-- Fix: paymentGateway.configure's onConflictDoUpdate targets (tenantId, provider),
-- but that pair has never had a matching unique constraint since the table was
-- created (0002_violet_gideon.sql) — every call has always failed with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
CREATE UNIQUE INDEX IF NOT EXISTS "pgc_tenant_provider_idx" ON "payment_gateway_configs" ("tenantId","provider");
