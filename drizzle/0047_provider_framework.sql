ALTER TABLE "payment_gateway_configs" ADD COLUMN IF NOT EXISTS "credentials" jsonb;
--> statement-breakpoint
ALTER TABLE "payment_gateway_configs" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_gateway_configs" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
