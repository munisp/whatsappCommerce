-- W12 tenancy: tenant type classification + multi-user tenant memberships + session revocations.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "tenantType" varchar(20) DEFAULT 'retailer' NOT NULL;
--> statement-breakpoint
-- Backfill: tenants that already have a supplier profile sell AND supply -> 'hybrid'.
UPDATE "tenants" AS t SET "tenantType" = 'hybrid'
FROM "supplier_profiles" AS sp
WHERE sp."tenant_id" = t."id";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"userId" varchar(36) NOT NULL,
	"role" varchar(20) DEFAULT 'operator' NOT NULL,
	"invitedBy" varchar(36),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_role_check" CHECK ("role" IN ('owner','operator','analyst'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenantId_tenants_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_memberships_tenant_user_uniq" ON "tenant_memberships" USING btree ("tenantId","userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_user_idx" ON "tenant_memberships" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_tenant_idx" ON "tenant_memberships" USING btree ("tenantId");
--> statement-breakpoint
-- Backfill: every user with users.tenantId set becomes the 'owner' of that tenant.
INSERT INTO "tenant_memberships" ("tenantId", "userId", "role")
SELECT u."tenantId", u."id"::varchar, 'owner'
FROM "users" AS u
WHERE u."tenantId" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_revocations" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"userId" varchar(36),
	"expiresAt" timestamp NOT NULL
);
