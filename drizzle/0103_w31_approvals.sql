-- W31 approvals (Coder C): threshold approval workflows.
-- approval_requests: one row per parked money action awaiting a decision.
-- Single-consumption is enforced app-side by guarded UPDATEs whose WHERE
-- clause includes status='pending' (concurrent approve/reject → 0 rows →
-- CONFLICT), mirroring the post-W30 claim-before-send doctrine.
-- tenant_approval_policies: per-tenant threshold policy; threshold_cents = 0
-- means approvals OFF (honest semantics: no policy / zero threshold → the
-- money action executes directly, pre-W31 behavior unchanged).
CREATE TABLE IF NOT EXISTS "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"target_id" varchar(64),
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"requested_by" varchar(36) NOT NULL,
	"approver_role" varchar(16) DEFAULT 'owner' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decided_by" varchar(36),
	"decided_at" timestamp,
	"decision_note" text,
	"step_up_challenge_id" varchar(36),
	"expires_at" timestamp NOT NULL,
	"executed_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_tenant_status_idx" ON "approval_requests" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_status_expires_idx" ON "approval_requests" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_approval_policies" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"threshold_cents" bigint DEFAULT 0 NOT NULL,
	"kinds" text[],
	"approver_role" varchar(16) DEFAULT 'owner' NOT NULL,
	"expiry_hours" integer DEFAULT 72 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(36)
);
