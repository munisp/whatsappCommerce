-- W27 (Coder G): stokvel / group savings circles + micro-insurance.
-- Additive only. ALL money is INTEGER CENTS.
CREATE TABLE IF NOT EXISTS "stokvel_circles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(160) NOT NULL,
	"contribution_amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"frequency" varchar(16) DEFAULT 'monthly' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"rotation_index" integer DEFAULT 0 NOT NULL,
	"current_cycle" integer DEFAULT 1 NOT NULL,
	"created_by_phone" varchar(32),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stokvel_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"circle_id" uuid NOT NULL,
	"phone" varchar(32) NOT NULL,
	"name" varchar(160),
	"rotation_position" integer NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stokvel_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"circle_id" uuid NOT NULL,
	"cycle" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"phone" varchar(32) NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"payment_ref" varchar(128),
	"paid_at" timestamp,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stokvel_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"circle_id" uuid NOT NULL,
	"cycle" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"phone" varchar(32) NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stokvel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"circle_id" uuid NOT NULL,
	"actor_phone" varchar(32),
	"kind" varchar(40) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insurance_products" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"premium_bps" integer DEFAULT 0 NOT NULL,
	"flat_premium_cents" integer DEFAULT 0 NOT NULL,
	"coverage_cents" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insurance_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(64) NOT NULL,
	"order_id" varchar(36),
	"holder_phone" varchar(32),
	"context_json" jsonb,
	"premium_cents" integer NOT NULL,
	"coverage_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'quoted' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insurance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"policy_number" varchar(32) NOT NULL,
	"quote_id" uuid NOT NULL,
	"product_id" varchar(64) NOT NULL,
	"order_id" varchar(36),
	"holder_phone" varchar(32),
	"premium_cents" integer NOT NULL,
	"coverage_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"bound_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insurance_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"policy_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"status" varchar(16) DEFAULT 'filed' NOT NULL,
	"payout_cents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "stokvel_members" ADD CONSTRAINT "stokvel_members_circle_id_stokvel_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."stokvel_circles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stokvel_contributions" ADD CONSTRAINT "stokvel_contributions_circle_id_stokvel_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."stokvel_circles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stokvel_contributions" ADD CONSTRAINT "stokvel_contributions_member_id_stokvel_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."stokvel_members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stokvel_payouts" ADD CONSTRAINT "stokvel_payouts_circle_id_stokvel_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."stokvel_circles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stokvel_payouts" ADD CONSTRAINT "stokvel_payouts_member_id_stokvel_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."stokvel_members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stokvel_events" ADD CONSTRAINT "stokvel_events_circle_id_stokvel_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."stokvel_circles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insurance_quotes" ADD CONSTRAINT "insurance_quotes_product_id_insurance_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."insurance_products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_quote_id_insurance_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."insurance_quotes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_product_id_insurance_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."insurance_products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_policy_id_insurance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."insurance_policies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stokvel_members_circle_phone_uniq" ON "stokvel_members" USING btree ("circle_id","phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_circles_tenant_idx" ON "stokvel_circles" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_circles_status_idx" ON "stokvel_circles" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_members_circle_idx" ON "stokvel_members" USING btree ("circle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_members_phone_idx" ON "stokvel_members" USING btree ("tenant_id","phone");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stokvel_contrib_circle_cycle_member_uniq" ON "stokvel_contributions" USING btree ("circle_id","cycle","member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_contrib_circle_cycle_idx" ON "stokvel_contributions" USING btree ("circle_id","cycle");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_contrib_status_idx" ON "stokvel_contributions" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stokvel_payout_circle_cycle_uniq" ON "stokvel_payouts" USING btree ("circle_id","cycle");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_payout_circle_idx" ON "stokvel_payouts" USING btree ("circle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stokvel_events_circle_idx" ON "stokvel_events" USING btree ("circle_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_products_tenant_idx" ON "insurance_products" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_quotes_tenant_idx" ON "insurance_quotes" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_quotes_order_idx" ON "insurance_quotes" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "insurance_policies_number_uniq" ON "insurance_policies" USING btree ("policy_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_policies_tenant_idx" ON "insurance_policies" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_policies_holder_idx" ON "insurance_policies" USING btree ("tenant_id","holder_phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_claims_policy_idx" ON "insurance_claims" USING btree ("policy_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_claims_tenant_idx" ON "insurance_claims" USING btree ("tenant_id");
