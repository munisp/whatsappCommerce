CREATE TYPE "public"."integration_type" AS ENUM('medusa', 'twenty_crm', 'odoo_erp', 'africa_talking', 'mtn_momo', 'mpesa', 'paystack', 'stripe', 'chatwoot', 'keycloak', 'shipbubble', 'custom');--> statement-breakpoint
CREATE TYPE "public"."provisioning_status" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."tenant_integration_status" AS ENUM('not_configured', 'pending', 'active', 'error', 'disabled');--> statement-breakpoint
CREATE TABLE "provisioning_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"integrationType" "integration_type" NOT NULL,
	"status" "provisioning_status" DEFAULT 'pending' NOT NULL,
	"stepName" varchar(128) NOT NULL,
	"stepIndex" integer DEFAULT 0 NOT NULL,
	"totalSteps" integer DEFAULT 1 NOT NULL,
	"inputPayload" jsonb DEFAULT '{}'::jsonb,
	"outputPayload" jsonb DEFAULT '{}'::jsonb,
	"errorMessage" text,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_integrations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"integrationType" "integration_type" NOT NULL,
	"status" "tenant_integration_status" DEFAULT 'not_configured' NOT NULL,
	"displayName" varchar(128),
	"baseUrl" varchar(512),
	"apiKey" text,
	"apiSecret" text,
	"webhookSecret" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"lastHealthCheck" timestamp,
	"lastHealthStatus" varchar(32),
	"lastError" text,
	"enabledAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unified_onboarding_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"currentStep" varchar(64) DEFAULT 'welcome' NOT NULL,
	"completedSteps" jsonb DEFAULT '[]'::jsonb,
	"businessProfile" jsonb DEFAULT '{}'::jsonb,
	"whatsappConfig" jsonb DEFAULT '{}'::jsonb,
	"crmConfig" jsonb DEFAULT '{}'::jsonb,
	"erpConfig" jsonb DEFAULT '{}'::jsonb,
	"ecommerceConfig" jsonb DEFAULT '{}'::jsonb,
	"channelsConfig" jsonb DEFAULT '{}'::jsonb,
	"paymentsConfig" jsonb DEFAULT '{}'::jsonb,
	"billingConfig" jsonb DEFAULT '{}'::jsonb,
	"isComplete" boolean DEFAULT false NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unified_onboarding_sessions_tenantId_unique" UNIQUE("tenantId")
);
--> statement-breakpoint
CREATE INDEX "provisioning_jobs_tenant_idx" ON "provisioning_jobs" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "provisioning_jobs_status_idx" ON "provisioning_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tenant_integrations_tenant_idx" ON "tenant_integrations" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_integrations_unique_idx" ON "tenant_integrations" USING btree ("tenantId","integrationType");--> statement-breakpoint
CREATE INDEX "unified_onboarding_tenant_idx" ON "unified_onboarding_sessions" USING btree ("tenantId");