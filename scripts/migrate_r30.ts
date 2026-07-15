import postgres from "postgres";

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) throw new Error("No DB URL");

const sql = postgres(url, { max: 1 });

await sql.unsafe(`CREATE TABLE IF NOT EXISTS "dataset_snapshots" ("id" varchar(36) PRIMARY KEY NOT NULL, "createdAt" timestamp DEFAULT now() NOT NULL, "createdBy" varchar(128), "label" varchar(256), "totalImages" integer NOT NULL, "bboxImages" integer NOT NULL, "qualityImages" integer NOT NULL, "classStats" jsonb NOT NULL, "notes" text)`);
await sql.unsafe(`CREATE TABLE IF NOT EXISTS "model_ab_tests" ("id" varchar(36) PRIMARY KEY NOT NULL, "modelName" varchar(128) NOT NULL, "championVersion" varchar(128) NOT NULL, "challengerVersion" varchar(128) NOT NULL, "trafficSplitPct" integer DEFAULT 20 NOT NULL, "status" varchar(32) DEFAULT 'running' NOT NULL, "championRequests" integer DEFAULT 0 NOT NULL, "challengerRequests" integer DEFAULT 0 NOT NULL, "championMetric" real, "challengerMetric" real, "pValue" real, "winner" varchar(32), "startedAt" timestamp DEFAULT now() NOT NULL, "concludedAt" timestamp, "notes" text)`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS "ds_snap_created_idx" ON "dataset_snapshots" ("createdAt")`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS "ab_model_idx" ON "model_ab_tests" ("modelName")`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS "ab_status_idx" ON "model_ab_tests" ("status")`);
console.log("Migration applied OK");
await sql.end();
