-- === W57 risk-shield: identity graph links + flags, cross-tenant default
-- registry, credit insurance policies/claims, provision fund ledger, and the
-- provision-fund bps config column on escrow_config. Additive-only; IF NOT
-- EXISTS / IF NOT EXISTS-index for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"subjectType" varchar(8) NOT NULL,
	"subjectId" varchar(64) NOT NULL,
	"linkType" varchar(16) NOT NULL,
	"linkHash" varchar(64) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_subject_link_uniq" ON "identity_links" ("subjectType", "subjectId", "linkType", "linkHash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_links_hash_idx" ON "identity_links" ("linkType", "linkHash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_links_subject_idx" ON "identity_links" ("subjectType", "subjectId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"subjectType" varchar(8) NOT NULL,
	"subjectId" varchar(64) NOT NULL,
	"kind" varchar(32) DEFAULT 'linked_default' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"evidence" jsonb,
	"disputeRef" varchar(64),
	"resolvedBy" varchar(255),
	"resolvedAt" timestamp,
	"resolutionNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_flags_subject_idx" ON "identity_flags" ("tenantId", "subjectType", "subjectId", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_default_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identityHash" varchar(64) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"accountId" varchar(64) NOT NULL,
	"amountCents" integer NOT NULL,
	"defaultedAt" timestamp DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"bureauRef" varchar(128),
	"curedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_default_registry_account_uniq" ON "credit_default_registry" ("tenantId", "accountId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_default_registry_hash_idx" ON "credit_default_registry" ("identityHash", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_insurance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"facilityRef" varchar(64) NOT NULL,
	"principalCents" integer NOT NULL,
	"premiumCents" integer NOT NULL,
	"grade" varchar(1) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"providerRef" varchar(128),
	"status" varchar(16) DEFAULT 'bound' NOT NULL,
	"idempotencyKey" varchar(160) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_insurance_policies_key_uniq" ON "credit_insurance_policies" ("idempotencyKey");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_insurance_policies_facility_uniq" ON "credit_insurance_policies" ("tenantId", "facilityRef");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_insurance_policies_tenant_idx" ON "credit_insurance_policies" ("tenantId", "createdAt");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_insurance_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"policyId" uuid NOT NULL,
	"defaultRef" varchar(64) NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'filed' NOT NULL,
	"payoutCents" integer,
	"idempotencyKey" varchar(160) NOT NULL,
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_insurance_claims_key_uniq" ON "credit_insurance_claims" ("idempotencyKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_insurance_claims_policy_idx" ON "credit_insurance_claims" ("policyId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_insurance_claims_tenant_idx" ON "credit_insurance_claims" ("tenantId", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provision_fund_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36),
	"kind" varchar(16) NOT NULL,
	"amountCents" integer NOT NULL,
	"ref" varchar(128) NOT NULL,
	"note" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provision_fund_ledger_ref_uniq" ON "provision_fund_ledger" ("ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provision_fund_ledger_tenant_idx" ON "provision_fund_ledger" ("tenantId", "createdAt");
--> statement-breakpoint
ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "provision_fund_bps" integer DEFAULT 250 NOT NULL;
