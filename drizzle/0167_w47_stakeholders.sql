-- === W47 stakeholders (Coder C): ONB-S-1/2/5/10/14 ===
-- ADDITIVE ONLY (hand-written; chained after 0162).
--
-- ONB-S-5:  tenant_invite_tokens.revoked_at — admin invite revocation.
-- ONB-S-2:  staff_invites — phone-bound invite→accept staff onboarding
--           (no phantom membership rows; membership created on acceptance).
-- ONB-S-10: riders registry + deliveries.rider_id — merchant-approved,
--           phone-bound riders with per-delivery assignment.
-- ONB-S-14: users.phone unique partial index (NULLs excluded) — one
--           canonical user row per phone number.
ALTER TABLE "tenant_invite_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "rider_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"role" varchar(16) DEFAULT 'operator' NOT NULL,
	"token" varchar(64) NOT NULL,
	"invited_by" varchar(36),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"accepted_user_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_invites_token_unique" ON "staff_invites" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_invites_tenant_idx" ON "staff_invites" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_invites_phone_idx" ON "staff_invites" USING btree ("tenant_id","phone");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "riders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"name" varchar(160) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"id_reference" varchar(64),
	"created_by" varchar(64),
	"approved_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "riders_tenant_phone_uq" ON "riders" USING btree ("tenant_id","phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "riders_tenant_idx" ON "riders" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_unique" ON "users" USING btree ("phone") WHERE "phone" IS NOT NULL;
