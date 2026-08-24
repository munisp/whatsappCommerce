-- W30 (Coder D): tenant invite magic-link registry (V2#13).
-- Additive only. Minted invite JWTs are recorded by jti; validation marks
-- the row consumed exactly once (single-use) and TTL is capped at 24h.
CREATE TABLE IF NOT EXISTS "tenant_invite_tokens" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"issued_by" varchar(36),
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invite_tokens_tenant_idx" ON "tenant_invite_tokens" USING btree ("tenant_id","created_at");
