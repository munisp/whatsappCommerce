-- === W54 capabilities (CAP-1 consumer membership tiers): membership_plans + customer_memberships.
-- Additive-only; IF NOT EXISTS for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "membership_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"priceCents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"period" varchar(8) DEFAULT 'month' NOT NULL,
	"discountPercent" integer DEFAULT 0 NOT NULL,
	"pointsMultiplier" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_plans_tenant_idx" ON "membership_plans" ("tenantId", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"planId" uuid NOT NULL,
	"customerId" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"currentPeriodEnd" timestamp,
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"orderId" varchar(36),
	"paymentRef" varchar(128),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_memberships_tenant_customer_idx" ON "customer_memberships" ("tenantId", "customerId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_memberships_plan_idx" ON "customer_memberships" ("tenantId", "planId");
--> statement-breakpoint
-- At most ONE live membership per (tenant, customer) — claim-first joins rely on this.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_memberships_live_uidx" ON "customer_memberships" USING btree ("tenantId", "customerId") WHERE "status" = 'active';
