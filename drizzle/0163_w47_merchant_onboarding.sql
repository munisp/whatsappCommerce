-- === W47 merchant ===
-- ONB-M-12: self-service staff invites during onboarding — a pending,
-- phone-bound invite the invitee claims on first OTP login (no more
-- "read me your internal user id").
-- ONB-M-13: stable reviewer identity for the KYB appeal 4-eyes rule.
CREATE TABLE IF NOT EXISTS "merchant_staff_invites" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"role" varchar(32) DEFAULT 'operator' NOT NULL,
	"invited_by" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"token" varchar(64) NOT NULL,
	"claimed_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"claimed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_staff_invites_tenant_phone_uq" ON "merchant_staff_invites" USING btree ("tenant_id","phone");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_staff_invites_token_uq" ON "merchant_staff_invites" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_staff_invites_tenant_idx" ON "merchant_staff_invites" USING btree ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "reviewedByUserId" integer;
