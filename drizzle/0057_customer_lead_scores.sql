-- W17 F11: CRM lead scoring on top of Twenty.
-- Additive-only: new table customer_lead_scores (one row per tenant+customer,
-- upserted by server/services/leadScoring.refreshLeadScores).
CREATE TABLE IF NOT EXISTS "customer_lead_scores" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerId" varchar(36) NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"band" varchar(10) DEFAULT 'cold' NOT NULL,
	"stage" varchar(20) DEFAULT 'new_lead' NOT NULL,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_lead_scores_tenant_idx" ON "customer_lead_scores" USING btree ("tenantId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_lead_scores_tenant_customer_uniq" ON "customer_lead_scores" USING btree ("tenantId","customerId");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_lead_scores" ADD CONSTRAINT "customer_lead_scores_customerId_customers_id_fk" FOREIGN KEY ("customerId") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
