-- === W44 deposits-subs-digital (Coder C): appointment deposits ===
-- ADDITIVE ONLY (hand-written; chained after 0135).
--
-- service_appointments: chat-booked service appointments (BOTH channels).
-- The deposit is captured via the EXISTING payment-intent path (reference
-- appt-deposit:<appointmentId>); the remainder is collected at completion
-- (wallet debit first, PSP payment link fallback — appt-remainder:<id>).
-- Cancel more than tenants."appointmentCancelWindowHours" (default 24)
-- before startsAt refunds the deposit via the W38 provider-refund path;
-- inside the window the deposit is forfeited (refund skipped + audit row).
-- No double-booking: booking claims with SELECT … FOR UPDATE over the
-- overlapping rows of the same (tenant, serviceProduct) before insert.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "appointmentCancelWindowHours" integer DEFAULT 24 NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "serviceBookingEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "serviceDurationMinutes" integer DEFAULT 60 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"service_product_id" varchar(36) NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"deposit_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"deposit_ref" varchar(128),
	"remainder_cents" integer DEFAULT 0 NOT NULL,
	"remainder_status" varchar(16),
	"remainder_ref" varchar(128),
	"status" varchar(16) DEFAULT 'booked' NOT NULL,
	"order_id" varchar(36),
	"channel" varchar(16) DEFAULT 'whatsapp' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_appt_tenant_product_time_idx" ON "service_appointments" USING btree ("tenant_id","service_product_id","starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_appt_tenant_customer_idx" ON "service_appointments" USING btree ("tenant_id","customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_appt_tenant_status_idx" ON "service_appointments" USING btree ("tenant_id","status");
