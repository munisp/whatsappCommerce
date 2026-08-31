-- W34 otel-sidecars (Coder C): tenant cardinality guard allowlist.
-- Only allowlisted tenants (union with the OTEL_TENANT_METRIC_ALLOWLIST env
-- CSV) receive a per-tenant label on /api/metrics; all others collapse to
-- tenant_class="other" so label cardinality stays bounded (J221).
-- Managed via the admin-only telemetry.setTenantAllowlist tRPC mutation.
CREATE TABLE IF NOT EXISTS "telemetry_tenant_allowlist" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"added_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
