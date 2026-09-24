-- === W47 crosscutting ===
-- ONB-ID-2 / ONB-ID-4 / ONB-TOCTOU-1: CAS backstops for select-then-insert
-- races. Defensive dedupe first (keep the most recent row per key), then the
-- unique constraints. Concurrent writers now conflict instead of forking
-- sessions / consent rows / OTP sessions; the code paths upsert + re-select.

-- nlp_sessions: one session per (tenantId, waPhoneNumber)
DELETE FROM "nlp_sessions" a USING "nlp_sessions" b
WHERE a."tenantId" = b."tenantId" AND a."waPhoneNumber" = b."waPhoneNumber"
  AND (a."lastActivityAt" < b."lastActivityAt"
       OR (a."lastActivityAt" = b."lastActivityAt" AND a."id" < b."id"));
--> statement-breakpoint
-- MERGER: the (tenantId, waPhoneNumber) unique index already exists as
-- "nlp_sessions_tenant_phone_uq" (mig 0166, buyer) — one physical index
-- satisfies both ONB-B-10 and ONB-ID-2; no duplicate created here.

-- phone_otp_sessions: one live session per (phone, purpose)
DELETE FROM "phone_otp_sessions" a USING "phone_otp_sessions" b
WHERE a."phone" = b."phone" AND a."purpose" = b."purpose"
  AND (a."created_at" < b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" < b."id"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_otp_sessions_phone_purpose_uniq" ON "phone_otp_sessions" USING btree ("phone","purpose");
--> statement-breakpoint

-- consents: one row per (tenant_id, phone, channel)
DELETE FROM "consents" a USING "consents" b
WHERE a."tenant_id" = b."tenant_id" AND a."phone" = b."phone" AND a."channel" = b."channel"
  AND (a."updated_at" < b."updated_at"
       OR (a."updated_at" = b."updated_at" AND a."id" < b."id"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consents_tenant_phone_channel_uniq" ON "consents" USING btree ("tenant_id","phone","channel");
--> statement-breakpoint

-- onboarding_sessions: at most one ACTIVE copilot session per (channel, phone)
-- (terminal states excluded so full history is preserved).
UPDATE "onboarding_sessions" a SET "state" = 'abandoned', "updated_at" = now()
FROM "onboarding_sessions" b
WHERE a."channel" = b."channel" AND a."phone" IS NOT NULL AND a."phone" = b."phone"
  AND a."state" NOT IN ('live','failed','abandoned')
  AND b."state" NOT IN ('live','failed','abandoned')
  AND (a."created_at" < b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" < b."id"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_sessions_active_phone_uniq" ON "onboarding_sessions" USING btree ("channel","phone") WHERE "state" NOT IN ('live','failed','abandoned') AND "phone" IS NOT NULL;
