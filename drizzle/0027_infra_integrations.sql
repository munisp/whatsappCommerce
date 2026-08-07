-- ============================================================
-- Migration 0027: Full Infrastructure Integration Schemas
-- Covers: Temporal, Fluvio, TigerBeetle, APISIX, Dapr,
--         OpenAppSec WAF, Lakehouse, Keycloak session cache
-- ============================================================

-- Temporal workflow status enum
DO $$ BEGIN
  CREATE TYPE "temporal_workflow_status" AS ENUM (
    'running','completed','failed','cancelled','timed_out','terminated'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- TigerBeetle account type enum
DO $$ BEGIN
  CREATE TYPE "tigerbeetle_account_type" AS ENUM (
    'merchant','escrow','platform_fee','float','suspense'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- APISIX route status enum
DO $$ BEGIN
  CREATE TYPE "apisix_route_status" AS ENUM ('active','inactive','draft');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Dapr event status enum
DO $$ BEGIN
  CREATE TYPE "dapr_event_status" AS ENUM ('published','failed','retrying');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- OpenAppSec severity enum
DO $$ BEGIN
  CREATE TYPE "openappsec_severity" AS ENUM (
    'critical','high','medium','low','info'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Lakehouse run status enum
DO $$ BEGIN
  CREATE TYPE "lakehouse_run_status" AS ENUM (
    'running','completed','failed','partial'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── temporal_workflow_runs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "temporal_workflow_runs" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id"   varchar(128) NOT NULL,
  "run_id"        varchar(128) NOT NULL UNIQUE,
  "workflow_type" varchar(128) NOT NULL,
  "task_queue"    varchar(128) NOT NULL DEFAULT 'whatsapp-commerce',
  "tenant_id"     varchar(36),
  "entity_id"     varchar(128),
  "status"        "temporal_workflow_status" NOT NULL DEFAULT 'running',
  "input"         jsonb,
  "result"        jsonb,
  "error_message" text,
  "started_at"    timestamp NOT NULL DEFAULT now(),
  "closed_at"     timestamp,
  "duration_ms"   integer
);
CREATE INDEX IF NOT EXISTS "temporal_runs_workflow_id_idx" ON "temporal_workflow_runs" USING btree ("workflow_id");
CREATE INDEX IF NOT EXISTS "temporal_runs_tenant_idx"      ON "temporal_workflow_runs" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "temporal_runs_type_idx"        ON "temporal_workflow_runs" USING btree ("workflow_type");
CREATE INDEX IF NOT EXISTS "temporal_runs_status_idx"      ON "temporal_workflow_runs" USING btree ("status");
CREATE INDEX IF NOT EXISTS "temporal_runs_started_idx"     ON "temporal_workflow_runs" USING btree ("started_at" DESC);

-- ── fluvio_event_log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "fluvio_event_log" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "topic"        varchar(128) NOT NULL,
  "offset"       bigint NOT NULL,
  "partition"    integer NOT NULL DEFAULT 0,
  "tenant_id"    varchar(36),
  "event_type"   varchar(128),
  "payload"      jsonb NOT NULL,
  "processed"    boolean NOT NULL DEFAULT false,
  "processed_at" timestamp,
  "error_msg"    text,
  "received_at"  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "fluvio_log_topic_idx"     ON "fluvio_event_log" USING btree ("topic");
CREATE INDEX IF NOT EXISTS "fluvio_log_tenant_idx"    ON "fluvio_event_log" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "fluvio_log_processed_idx" ON "fluvio_event_log" USING btree ("processed");
CREATE INDEX IF NOT EXISTS "fluvio_log_received_idx"  ON "fluvio_event_log" USING btree ("received_at" DESC);

-- ── tigerbeetle_accounts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tigerbeetle_accounts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tb_account_id"   varchar(64) NOT NULL UNIQUE,
  "tenant_id"       varchar(36),
  "account_type"    "tigerbeetle_account_type" NOT NULL,
  "currency"        varchar(8) NOT NULL DEFAULT 'NGN',
  "ledger_id"       integer NOT NULL DEFAULT 700,
  "code"            integer NOT NULL DEFAULT 1000,
  "flags"           integer NOT NULL DEFAULT 0,
  "debits_pending"  bigint NOT NULL DEFAULT 0,
  "debits_posted"   bigint NOT NULL DEFAULT 0,
  "credits_pending" bigint NOT NULL DEFAULT 0,
  "credits_posted"  bigint NOT NULL DEFAULT 0,
  "last_synced_at"  timestamp,
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "updated_at"      timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tb_accounts_tenant_idx" ON "tigerbeetle_accounts" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "tb_accounts_type_idx"   ON "tigerbeetle_accounts" USING btree ("account_type");

-- ── apisix_route_configs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "apisix_route_configs" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "route_id"       varchar(64) NOT NULL UNIQUE,
  "tenant_id"      varchar(36),
  "name"           varchar(255) NOT NULL,
  "uri"            varchar(512) NOT NULL,
  "methods"        jsonb NOT NULL DEFAULT '["GET","POST"]',
  "upstream_url"   varchar(512) NOT NULL,
  "plugins"        jsonb,
  "status"         "apisix_route_status" NOT NULL DEFAULT 'active',
  "rate_limit_rpm" integer DEFAULT 1000,
  "apisix_synced"  boolean NOT NULL DEFAULT false,
  "last_synced_at" timestamp,
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "updated_at"     timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "apisix_routes_tenant_idx" ON "apisix_route_configs" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "apisix_routes_status_idx" ON "apisix_route_configs" USING btree ("status");

-- ── dapr_event_log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "dapr_event_log" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pubsub_name"  varchar(128) NOT NULL,
  "topic"        varchar(256) NOT NULL,
  "tenant_id"    varchar(36),
  "entity_id"    varchar(128),
  "event_type"   varchar(128),
  "payload"      jsonb NOT NULL,
  "status"       "dapr_event_status" NOT NULL DEFAULT 'published',
  "error_msg"    text,
  "retry_count"  integer NOT NULL DEFAULT 0,
  "published_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dapr_log_topic_idx"     ON "dapr_event_log" USING btree ("topic");
CREATE INDEX IF NOT EXISTS "dapr_log_tenant_idx"    ON "dapr_event_log" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "dapr_log_status_idx"    ON "dapr_event_log" USING btree ("status");
CREATE INDEX IF NOT EXISTS "dapr_log_published_idx" ON "dapr_event_log" USING btree ("published_at" DESC);

-- ── openappsec_waf_events ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "openappsec_waf_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"   varchar(36),
  "severity"    "openappsec_severity" NOT NULL DEFAULT 'medium',
  "attack_type" varchar(128),
  "source_ip"   varchar(45),
  "request_uri" text,
  "method"      varchar(10),
  "user_agent"  text,
  "blocked"     boolean NOT NULL DEFAULT true,
  "raw_event"   jsonb,
  "detected_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "waf_events_tenant_idx"   ON "openappsec_waf_events" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "waf_events_severity_idx" ON "openappsec_waf_events" USING btree ("severity");
CREATE INDEX IF NOT EXISTS "waf_events_detected_idx" ON "openappsec_waf_events" USING btree ("detected_at" DESC);
CREATE INDEX IF NOT EXISTS "waf_events_ip_idx"       ON "openappsec_waf_events" USING btree ("source_ip");

-- ── lakehouse_pipeline_runs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lakehouse_pipeline_runs" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pipeline_type"    varchar(64) NOT NULL,
  "stage"            varchar(64) NOT NULL,
  "status"           "lakehouse_run_status" NOT NULL DEFAULT 'running',
  "records_extracted" integer DEFAULT 0,
  "records_loaded"   integer DEFAULT 0,
  "features_written" integer DEFAULT 0,
  "model_version"    varchar(64),
  "duration_ms"      integer,
  "error_msg"        text,
  "metadata"         jsonb,
  "started_at"       timestamp NOT NULL DEFAULT now(),
  "completed_at"     timestamp
);
CREATE INDEX IF NOT EXISTS "lakehouse_runs_type_idx"    ON "lakehouse_pipeline_runs" USING btree ("pipeline_type");
CREATE INDEX IF NOT EXISTS "lakehouse_runs_status_idx"  ON "lakehouse_pipeline_runs" USING btree ("status");
CREATE INDEX IF NOT EXISTS "lakehouse_runs_started_idx" ON "lakehouse_pipeline_runs" USING btree ("started_at" DESC);

-- ── Additional optimized indexes on existing high-traffic tables ──────────────
CREATE INDEX IF NOT EXISTS "orders_created_at_idx"     ON "orders" USING btree ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "orders_payment_status_idx" ON "orders" USING btree ("paymentStatus");
CREATE INDEX IF NOT EXISTS "conversations_updated_idx" ON "conversations" USING btree ("updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "agent_events_type_idx"     ON "agent_events" USING btree ("eventType");
CREATE INDEX IF NOT EXISTS "products_category_idx"     ON "products" USING btree ("category");
CREATE INDEX IF NOT EXISTS "products_stock_idx"        ON "products" USING btree ("stockQuantity");
CREATE INDEX IF NOT EXISTS "payment_intents_created_idx" ON "payment_intents" USING btree ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "webhook_events_created_idx"  ON "webhook_events" USING btree ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "customers_phone_idx"       ON "customers" USING btree ("whatsappPhone");
-- NOTE: escrow_state_idx and shipment_status_idx already exist (created in 0003) and are not re-created here.
CREATE INDEX IF NOT EXISTS "escrow_transactions_tenant_idx" ON "escrow_transactions" USING btree ("tenant_id");
