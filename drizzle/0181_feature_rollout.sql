CREATE TABLE IF NOT EXISTS "feature_rollouts" (
  "feature_key" varchar(120) PRIMARY KEY NOT NULL,
  "state" varchar(16) DEFAULT 'all' NOT NULL,
  "released_at" timestamp,
  "updated_by" varchar(64),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_feature_overrides" (
  "tenant_id" varchar(36) NOT NULL,
  "feature_key" varchar(120) NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_by" varchar(64),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_feature_override_uniq" ON "tenant_feature_overrides" ("tenant_id", "feature_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_feature_override_key_idx" ON "tenant_feature_overrides" ("feature_key");
