-- === W47 crosscutting ===
-- ONB-TOCTOU-2: age attestations carry proof-of-attestation versioning
-- (policy version + inbound evidence wamid), mirroring consents TEN-16.
-- Additive columns only.
ALTER TABLE "age_attestations" ADD COLUMN IF NOT EXISTS "policy_version" varchar(40);
--> statement-breakpoint
ALTER TABLE "age_attestations" ADD COLUMN IF NOT EXISTS "proof_wamid" varchar(80);
