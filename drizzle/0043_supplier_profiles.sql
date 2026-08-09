CREATE TABLE IF NOT EXISTS "supplier_profiles" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"moq_cents" bigint DEFAULT 0 NOT NULL,
	"lead_time_days" integer DEFAULT 3 NOT NULL,
	"terms_offered" jsonb,
	"default_terms_days" integer DEFAULT 14 NOT NULL,
	"auto_approve_below_cents" bigint,
	"categories" jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
