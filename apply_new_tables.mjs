import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'fs';

// Load env
const envFile = readFileSync('/home/ubuntu/whatsapp-commerce/.env', 'utf8');
const envVars = {};
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) envVars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
}
const connStr = envVars.POSTGRES_URL || envVars.DATABASE_URL;
if (!connStr) { console.error('No DB URL'); process.exit(1); }

const postgres = (await import('/home/ubuntu/whatsapp-commerce/node_modules/postgres/src/index.js')).default;
const sql = postgres(connStr, { ssl: 'require', max: 1 });

try {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "forecast_snapshots" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "snapshot_month" varchar(7) NOT NULL,
      "projected_revenue" numeric(14,4) NOT NULL,
      "projected_gmv" numeric(14,4) NOT NULL,
      "actual_revenue" numeric(14,4),
      "actual_gmv" numeric(14,4),
      "accuracy_pct" numeric(7,4),
      "resolved_at" timestamp,
      "created_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "forecast_snapshots_month_idx" ON "forecast_snapshots"("snapshot_month");
  `);
  console.log('forecast_snapshots created');

  await sql.unsafe(`
    DO $$ BEGIN
      CREATE TYPE "cogs_dispute_status" AS ENUM ('pending', 'approved', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "cogs_dispute_requests" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenant_id" varchar(36) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
      "current_cogs_rate" numeric(5,4) NOT NULL,
      "requested_cogs_rate" numeric(5,4) NOT NULL,
      "justification" text,
      "status" "cogs_dispute_status" NOT NULL DEFAULT 'pending',
      "reviewed_by" varchar(128),
      "review_note" text,
      "reviewed_at" timestamp,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "cogs_dispute_tenant_idx" ON "cogs_dispute_requests"("tenant_id");
    CREATE INDEX IF NOT EXISTS "cogs_dispute_status_idx" ON "cogs_dispute_requests"("status");
  `);
  console.log('cogs_dispute_requests created');
} catch(e) {
  console.error(e.message);
} finally {
  await sql.end();
}
