/**
 * W42 (PLT-15) — real-PG integration profile for the money paths.
 *
 * The default simulation world boots PGlite, which never exercises behaviors
 * that only exist in real PostgreSQL (pg_advisory_xact_lock in loyalty.ts,
 * FOR UPDATE SKIP LOCKED in inventory.ts, deferrable/unique partial indexes
 * from migrations 0088/0099, real lock_timeout/statement_timeout).
 *
 * This script runs the W38 refund/clawback money-integrity journey suite
 * (J247–J253) against a REAL PostgreSQL — the postgres:16 service already
 * declared in docker-compose.yml — by booting the world in external-PG mode
 * (SIM_DATABASE_URL, see simulation/world.ts "W42 pg-integration").
 *
 * Usage:
 *   docker compose up -d postgres           # real PG (compose service)
 *   PG_INTEGRATION=1 npm run test:pg-integration
 *
 * Gating (honest-skip doctrine):
 *   - PG_INTEGRATION != 1          → SKIP (exit 0), prints how to enable.
 *   - PG unreachable               → SKIP (exit 0) unless PG_INTEGRATION_STRICT=1.
 *   - Everything passes            → exit 0; journey failures → exit 1.
 */
import { spawnSync } from "node:child_process";

export interface PgIntegrationGate {
  enabled: boolean;
  reason: string;
  databaseUrl?: string;
}

const DEFAULT_URL = "postgres://wc_user:wc_secret@127.0.0.1:5432/postgres";
const MONEY_PATH_JOURNEYS = ["J247", "J248", "J249", "J250", "J251", "J252", "J253"];

/** Honest gate — also pinned by journey J318. */
export function pgIntegrationGate(env: NodeJS.ProcessEnv = process.env): PgIntegrationGate {
  if (env.PG_INTEGRATION !== "1") {
    return {
      enabled: false,
      reason:
        "PG_INTEGRATION is not 1 — real-PG money-path profile is opt-in. " +
        "Run `docker compose up -d postgres` then PG_INTEGRATION=1 npm run test:pg-integration.",
    };
  }
  return {
    enabled: true,
    reason: "PG_INTEGRATION=1",
    databaseUrl: env.PG_INTEGRATION_DATABASE_URL ?? DEFAULT_URL,
  };
}

async function probe(url: string): Promise<boolean> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, connect_timeout: 5 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

function adminUrl(url: string): string {
  // Connect to the maintenance `postgres` db to create/drop the scratch db.
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

async function main(): Promise<number> {
  const gate = pgIntegrationGate();
  if (!gate.enabled) {
    console.log(`[pg-integration] SKIP: ${gate.reason}`);
    return 0;
  }
  const serverUrl = adminUrl(gate.databaseUrl!);
  if (!(await probe(serverUrl))) {
    const msg =
      `[pg-integration] SKIP: real PostgreSQL unreachable at ${serverUrl}. ` +
      `Start it (docker compose up -d postgres) or unset PG_INTEGRATION.`;
    if (process.env.PG_INTEGRATION_STRICT === "1") {
      console.error(`[pg-integration] FAIL (strict): ${msg}`);
      return 1;
    }
    console.log(msg);
    return 0;
  }

  const scratchDb = `wc_integration_${process.pid}`;
  const { default: postgres } = await import("postgres");
  const admin = postgres(serverUrl, { max: 1 });
  const scratchUrl = (() => {
    const u = new URL(gate.databaseUrl!);
    u.pathname = `/${scratchDb}`;
    return u.toString();
  })();
  try {
    console.log(`[pg-integration] creating scratch database ${scratchDb}`);
    await admin.unsafe(`CREATE DATABASE "${scratchDb}"`);
    console.log(`[pg-integration] running W38 refund/clawback suite (${MONEY_PATH_JOURNEYS.join(" ")}) against real PG`);
    const res = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "simulation/runner.ts", ...MONEY_PATH_JOURNEYS],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          SIM_DATABASE_URL: scratchUrl,
          SIM_TRANSCRIPTS: "off",
        },
      }
    );
    const code = res.status ?? 1;
    console.log(code === 0
      ? "[pg-integration] PASS: W38 money-path suite green against real PostgreSQL"
      : `[pg-integration] FAIL: suite exited ${code} against real PostgreSQL`);
    return code;
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`).catch((e) => {
      console.warn(`[pg-integration] could not drop ${scratchDb}: ${e?.message ?? e}`);
    });
    await admin.end().catch(() => undefined);
  }
}

const isMain = !!process.argv[1] && /pg-integration-money-paths\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("[pg-integration] crashed:", e);
      process.exit(2);
    });
}
