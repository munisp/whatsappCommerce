-- === W47 buyer (Coder B) ===
-- ONB-B-6: telegram:<chat_id> session keys reach 22+ chars and overflowed
-- the legacy width on phone-keyed session tables — widen to varchar(64)
-- (additive; the DB was already at 40 for nlp_sessions via mig 0118, the
-- schema.ts column at 20 — both now agree on 64).
ALTER TABLE "nlp_sessions" ALTER COLUMN "waPhoneNumber" TYPE varchar(64);
--> statement-breakpoint
ALTER TABLE "cart_sessions" ALTER COLUMN "waPhoneNumber" TYPE varchar(64);
--> statement-breakpoint
-- ONB-B-2: recycled-number / SIM-swap protection marker on the chat buyer
-- identity. NULL = the current holder of this phone has NOT proven continuity
-- (name-confirmation challenge or portal device-auth link) — order-history /
-- tracking / inherited-consent disclosure on the chat surface verifies first.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "chatIdentityVerifiedAt" timestamp;
