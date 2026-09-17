-- W40 (Coder C): messaging compliance + resilience — ADDITIVE ONLY
-- (hand-written, journaled after 0122; idx 0123-0125 reserved for Coders
-- A/B, merger re-chains per SPEC_W40).
--
-- MSG-2 (template-status webhooks): Meta message_template_status_update
-- events carry a DISABLED terminal state that the pre-W40
-- template_approval_status enum could not represent — add it so the
-- webhook handler can persist the honest status and the send-side gate
-- (assertTemplateSendable) can block campaign sends on dead templates.
--
-- MSG-3 (broadcast circuit breaker): campaigns that exceed the failure
-- threshold (>20% failures after >=20 real send attempts) auto-pause.
-- "paused" is a new broadcast_status enum value; pausedReason/pausedAt
-- document the trip and support the documented resume procedure
-- (broadcast.resume -> draft, then an explicit merchant re-send).
ALTER TYPE "template_approval_status" ADD VALUE IF NOT EXISTS 'disabled';
--> statement-breakpoint
ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'paused';
--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD COLUMN IF NOT EXISTS "pausedReason" varchar(500);
--> statement-breakpoint
ALTER TABLE "broadcast_campaigns" ADD COLUMN IF NOT EXISTS "pausedAt" timestamp;
