-- === W56 credit: credit_scores + bureau consent artefacts + pull history + report-back outbox.
-- Additive-only; IF NOT EXISTS for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "credit_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"subjectType" varchar(8) NOT NULL,
	"subjectId" varchar(64) NOT NULL,
	"score" integer NOT NULL,
	"grade" varchar(1) NOT NULL,
	"factors" jsonb NOT NULL,
	"computedAt" timestamp DEFAULT now() NOT NULL,
	"version" varchar(32) DEFAULT 'w56-v1' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_scores_subject_uniq" ON "credit_scores" ("tenantId", "subjectType", "subjectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_scores_tenant_idx" ON "credit_scores" ("tenantId", "subjectType");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bureau_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"subjectType" varchar(8) NOT NULL,
	"subjectId" varchar(64) NOT NULL,
	"consentTextVersion" varchar(32) NOT NULL,
	"consentText" text NOT NULL,
	"channel" varchar(16) NOT NULL,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_consents_subject_idx" ON "bureau_consents" ("tenantId", "subjectType", "subjectId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bureau_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"subjectType" varchar(8) NOT NULL,
	"subjectId" varchar(64) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"consentId" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'ok' NOT NULL,
	"report" jsonb,
	"rawRef" varchar(128),
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_pulls_subject_idx" ON "bureau_pulls" ("tenantId", "subjectType", "subjectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_pulls_tenant_idx" ON "bureau_pulls" ("tenantId", "createdAt");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bureau_report_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"subjectType" varchar(8) NOT NULL,
	"subjectId" varchar(64) NOT NULL,
	"eventType" varchar(24) NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotencyKey" varchar(160) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextRetryAt" timestamp,
	"reportedAt" timestamp,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bureau_report_outbox_key_uniq" ON "bureau_report_outbox" ("idempotencyKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_report_outbox_due_idx" ON "bureau_report_outbox" ("status", "nextRetryAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bureau_report_outbox_tenant_idx" ON "bureau_report_outbox" ("tenantId");
