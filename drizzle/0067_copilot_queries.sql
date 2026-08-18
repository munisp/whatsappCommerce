-- W22: LLM copilot invocation log.
-- copilot_queries: audit trail for server/services/llmCopilot.ts
--   (merchant Q&A 'ask' + SOC2 incident 'triage'). Stores ONLY the sha256
--   prompt hash, fallback flag and latency — never raw prompts, answers,
--   or PII. kind is 'triage' | 'ask'. Additive only.
CREATE TABLE IF NOT EXISTS "copilot_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"prompt_hash" varchar(64) NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_queries_tenant_idx" ON "copilot_queries" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_queries_tenant_created_idx" ON "copilot_queries" USING btree ("tenant_id","created_at");
