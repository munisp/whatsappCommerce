/**
 * scripts/migrate-prod.ts — Production migration runner with safety gates.
 *
 * Reuses drizzle-kit's own migration format and ledger:
 *   - reads `drizzle/meta/_journal.json` + `drizzle/<tag>.sql` files,
 *   - hashes each file exactly like drizzle's migrator (sha256 of file text),
 *   - records applied migrations in `drizzle.__drizzle_migrations`,
 * so it is fully compatible with `npm run db:push` (drizzle-kit migrate) —
 * either tool sees the other's applied state.
 *
 * Production hardening on top of `drizzle-kit migrate`:
 *   1. pg_advisory_lock — only one migrator may run at a time (deploy races).
 *   2. Pre-flight diff — journal tags ↔ applied migrations table; prints the
 *      pending list BEFORE touching anything.
 *   3. --dry-run — prints the pending SQL without applying (exempt from the
 *      backup gate).
 *   4. Backup gate — refuses to apply unless CONFIRM_BACKUP=yes is in the env.
 *   5. Per-migration transaction (postgres.js supports tx for DDL here);
 *      stop-on-first-error with explicit resume instructions — a migration is
 *      never left half-applied silently.
 *   6. Post-apply verification — every journal tag must be present in the
 *      migrations table or the run exits non-zero.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrate-prod.ts --dry-run
 *   DATABASE_URL=... CONFIRM_BACKUP=yes npx tsx scripts/migrate-prod.ts
 *
 * The module is import-safe (no side effects on import) so tests can inject a
 * fake MigrateDb — no real database required.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");
export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";
/** Fixed advisory-lock key (arbitrary constant; must be stable across deploys). */
export const ADVISORY_LOCK_KEY = 727_272_001;

export interface MigrationMeta {
  tag: string;
  sql: string[];
  hash: string;
  folderMillis: number;
  breakpoints: boolean;
}

/** Raised when the operator has not confirmed a recent backup exists. */
export class BackupNotConfirmedError extends Error {
  constructor() {
    super("backup not confirmed — set CONFIRM_BACKUP=yes to proceed (see warning above)");
    this.name = "BackupNotConfirmedError";
  }
}

/** Raised when another migrator holds the advisory lock. */
export class MigrationLockError extends Error {
  constructor() {
    super("could not acquire pg_advisory_lock — another migration may be running; refusing to proceed");
    this.name = "MigrationLockError";
  }
}

/** Raised when post-apply verification finds journal tags missing from the ledger. */
export class MigrationVerificationError extends Error {
  constructor(public readonly missingTags: string[]) {
    super(`post-apply verification failed — journal tags not recorded as applied: ${missingTags.join(", ")}`);
    this.name = "MigrationVerificationError";
  }
}

/**
 * Read the journal + SQL files, hashing exactly like drizzle's migrator
 * (sha256 of the full file text; statements split on `--> statement-breakpoint`).
 */
export function readJournalMigrations(folder: string = MIGRATIONS_FOLDER): MigrationMeta[] {
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find meta/_journal.json in ${folder}`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
  };
  return journal.entries.map((entry) => {
    const migrationPath = path.join(folder, `${entry.tag}.sql`);
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`journal entry ${entry.tag} has no file ${migrationPath}`);
    }
    const query = fs.readFileSync(migrationPath, "utf8");
    return {
      tag: entry.tag,
      sql: query.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0),
      hash: crypto.createHash("sha256").update(query).digest("hex"),
      folderMillis: entry.when,
      breakpoints: entry.breakpoints,
    };
  });
}

/** Journal migrations whose hash is not yet recorded in the applied ledger. */
export function computePending(migrations: MigrationMeta[], appliedHashes: ReadonlySet<string>): MigrationMeta[] {
  return migrations.filter((m) => !appliedHashes.has(m.hash));
}

/** Journal entries already recorded — used by the pre-flight state report. */
export function computeApplied(migrations: MigrationMeta[], appliedHashes: ReadonlySet<string>): MigrationMeta[] {
  return migrations.filter((m) => appliedHashes.has(m.hash));
}

export const BACKUP_WARNING = `
================================================================================
 PRODUCTION MIGRATION — BACKUP REQUIRED
================================================================================
 You are about to apply schema migrations to the database at DATABASE_URL.

 BEFORE proceeding you MUST have a verified backup:
   1. Trigger a fresh snapshot / pg_dump (see docs/RUNBOOK_ROLLBACK.md).
      NOTE (W46 PLT-22): the runner now ALSO takes an automatic pre-migration
      logical dump (pg_dump custom format → PRE_MIGRATION_DUMP_DIR, uploaded
      to object storage when PRE_MIGRATION_DUMP_S3_BUCKET is set). Set
      PRE_MIGRATION_DUMP=required to fail closed when the dump cannot run.
   2. Confirm the backup COMPLETED and a restore rehearsal has been done
      against a copy (an untested backup is not a backup).
   3. Note the pre-migration row counts for critical tables.

 Then re-run with:

   CONFIRM_BACKUP=yes npx tsx scripts/migrate-prod.ts

 (--dry-run does not modify the database and does not require this flag.)
================================================================================`;

export function resumeInstructions(failedTag: string): string {
  return `
--------------------------------------------------------------------------------
 MIGRATION STOPPED at "${failedTag}" (stop-on-first-error).
 The failing migration was rolled back inside its transaction where the driver
 allows transactional DDL; earlier migrations in this run ARE committed and
 recorded in ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}.

 To resume:
   1. Inspect the error above and the migration file drizzle/${failedTag}.sql.
   2. Fix the database state (or the migration) manually.
   3. Re-run: CONFIRM_BACKUP=yes npx tsx scripts/migrate-prod.ts
      Already-applied migrations are skipped automatically — the run resumes
      exactly at "${failedTag}".
   4. If you must abandon the deploy, follow docs/RUNBOOK_ROLLBACK.md.
--------------------------------------------------------------------------------`;
}

/**
 * Database abstraction — injectable for tests. Implementations must guarantee
 * that applyMigration is atomic (single transaction) for a whole migration.
 */
export interface MigrateDb {
  /** Create schema + ledger table if missing, then acquire the advisory lock. */
  prepareAndLock(): Promise<void>;
  /** Hashes currently recorded in drizzle.__drizzle_migrations. */
  appliedHashes(): Promise<string[]>;
  /** Apply one migration's statements + record it, atomically. */
  applyMigration(m: MigrationMeta): Promise<void>;
  /** Release the advisory lock and close connections. */
  close(): Promise<void>;
}

/** postgres.js-backed MigrateDb (production path). */
export function createPostgresMigrateDb(databaseUrl: string): MigrateDb {
  // Lazy require so importing this module for tests never loads the driver.
  let sqlClient: any = null;
  const client = async () => {
    if (!sqlClient) {
      const { default: postgres } = await import("postgres");
      // max: 1 → every statement runs on ONE session, which is what makes the
      // session-scoped pg_advisory_lock cover the whole run.
      sqlClient = postgres(databaseUrl, { max: 1 });
    }
    return sqlClient;
  };
  return {
    async prepareAndLock() {
      const sql = await client();
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${MIGRATIONS_SCHEMA}`);
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )`,
      );
      const rows = await sql.unsafe(`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`);
      if (!rows[0]?.locked) throw new MigrationLockError();
    },
    async appliedHashes() {
      const sql = await client();
      const rows = await sql.unsafe(`SELECT hash FROM ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`);
      return rows.map((r: any) => String(r.hash));
    },
    async applyMigration(m: MigrationMeta) {
      const sql = await client();
      await sql.begin(async (tx: any) => {
        for (const statement of m.sql) {
          await tx.unsafe(statement);
        }
        await tx.unsafe(
          `INSERT INTO ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (hash, created_at) VALUES ($1, $2)`,
          [m.hash, m.folderMillis],
        );
      });
    },
    async close() {
      if (sqlClient) {
        await sqlClient.unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => undefined);
        await sqlClient.end();
        sqlClient = null;
      }
    },
  };
}

// === W46 platform-p2 (PLT-22) === pre-migration logical dump.
//
// Before any migration is applied, take a LOGICAL dump (pg_dump custom
// format) so a bad migration has a same-day restore point independent of
// the scheduled W39 backups. The dump lands in PRE_MIGRATION_DUMP_DIR
// (default ./backups/pre-migration) and, when PRE_MIGRATION_DUMP_S3_BUCKET
// is set, is additionally uploaded to object storage (MinIO/S3) under
// `pre-migration/<timestamp>.dump`.
//
// Modes (env PRE_MIGRATION_DUMP):
//   off      — skip the dump entirely (NOT recommended for prod)
//   auto     — dump best-effort; a missing pg_dump binary or failed dump
//              logs a LOUD warning but does not block (default)
//   required — dump failure ABORTS the run (fail-closed; prod posture)
export class PreMigrationDumpError extends Error {
  constructor(detail: string) {
    super(`pre-migration dump failed (PRE_MIGRATION_DUMP=required): ${detail}`);
    this.name = "PreMigrationDumpError";
  }
}

export interface PreMigrationDumpResult {
  status: "off" | "skipped-no-url" | "local" | "uploaded" | "failed";
  path?: string;
  objectKey?: string;
  error?: string;
}

export async function runPreMigrationDump(opts: {
  databaseUrl?: string;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}): Promise<PreMigrationDumpResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const env = opts.env ?? process.env;
  const mode = (env.PRE_MIGRATION_DUMP ?? "auto").trim().toLowerCase();
  if (mode === "off") {
    log("[migrate-prod] PRE_MIGRATION_DUMP=off — skipping pre-migration dump (NOT recommended for production)");
    return { status: "off" };
  }
  const url = opts.databaseUrl ?? env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!url) {
    const r: PreMigrationDumpResult = { status: "skipped-no-url", error: "no DATABASE_URL available for pg_dump" };
    if (mode === "required") throw new PreMigrationDumpError(r.error!);
    log(`[migrate-prod] WARNING: ${r.error}`);
    return r;
  }
  const dir = path.resolve(env.PRE_MIGRATION_DUMP_DIR ?? path.join("backups", "pre-migration"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `pre-migration-${stamp}.dump`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync("pg_dump", ["--dbname", url, "--format=custom", "--file", file], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30 * 60_000,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`pg_dump exited ${res.status}: ${String(res.stderr ?? "").slice(0, 400)}`);
    log(`[migrate-prod] pre-migration logical dump written: ${file}`);
  } catch (err: any) {
    const msg = `pg_dump failed: ${err?.message ?? err}`;
    if (mode === "required") throw new PreMigrationDumpError(msg);
    log(`[migrate-prod] WARNING: ${msg} — proceeding without a pre-migration dump (PRE_MIGRATION_DUMP=auto)`);
    return { status: "failed", error: msg };
  }
  // Optional object-storage upload (MinIO/S3-compatible).
  const bucket = (env.PRE_MIGRATION_DUMP_S3_BUCKET ?? "").trim();
  if (!bucket) return { status: "local", path: file };
  try {
    const { Client } = await import("minio");
    const endpointRaw = (env.S3_ENDPOINT ?? "").trim();
    const endpointUrl = endpointRaw.startsWith("http") ? new URL(endpointRaw) : null;
    const client = new Client(endpointUrl
      ? {
          endPoint: endpointUrl.hostname,
          port: Number(endpointUrl.port || (endpointUrl.protocol === "https:" ? 443 : 80)),
          useSSL: endpointUrl.protocol === "https:",
          accessKey: env.S3_ACCESS_KEY ?? "",
          secretKey: env.S3_SECRET_KEY ?? "",
        }
      : { endPoint: endpointRaw, useSSL: false, accessKey: env.S3_ACCESS_KEY ?? "", secretKey: env.S3_SECRET_KEY ?? "" });
    const objectKey = `pre-migration/${path.basename(file)}`;
    await client.fPutObject(bucket, objectKey, file, { "Content-Type": "application/octet-stream" });
    log(`[migrate-prod] pre-migration dump uploaded: s3://${bucket}/${objectKey}`);
    return { status: "uploaded", path: file, objectKey };
  } catch (err: any) {
    const msg = `dump upload to ${bucket} failed: ${err?.message ?? err} (local copy retained at ${file})`;
    if (mode === "required") throw new PreMigrationDumpError(msg);
    log(`[migrate-prod] WARNING: ${msg}`);
    return { status: "local", path: file, error: msg };
  }
}
// === END W46 platform-p2 (PLT-22) ===

export interface RunMigrationsOptions {
  db: MigrateDb;
  folder?: string;
  dryRun?: boolean;
  /** Raw env map — tests inject { CONFIRM_BACKUP: "yes" } instead of touching process.env. */
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** W46 PLT-22: connection string handed to pg_dump for the pre-migration dump. */
  databaseUrl?: string;
}

export interface RunMigrationsResult {
  status: "dry-run" | "applied" | "up-to-date" | "backup-refused";
  pending: MigrationMeta[];
  applied: MigrationMeta[];
}

export async function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun ?? false;
  const folder = opts.folder ?? MIGRATIONS_FOLDER;

  const migrations = readJournalMigrations(folder);

  // Backup gate — dry-run is exempt (it never touches the DB).
  if (!dryRun && env.CONFIRM_BACKUP !== "yes") {
    log(BACKUP_WARNING);
    return { status: "backup-refused", pending: [], applied: [] };
  }

  await opts.db.prepareAndLock();
  try {
    const appliedSet = new Set(await opts.db.appliedHashes());
    const applied = computeApplied(migrations, appliedSet);
    const pending = computePending(migrations, appliedSet);

    // ── Pre-flight report ─────────────────────────────────────────────────
    log(`[migrate-prod] journal entries: ${migrations.length}`);
    log(`[migrate-prod] already applied : ${applied.length}`);
    log(`[migrate-prod] pending         : ${pending.length}`);
    for (const m of pending) log(`  - ${m.tag} (${m.sql.length} statements)`);

    // Drift check: applied hashes that no longer match ANY journal entry.
    const journalHashes = new Set(migrations.map((m) => m.hash));
    const unknown = [...appliedSet].filter((h) => !journalHashes.has(h));
    if (unknown.length > 0) {
      log(`[migrate-prod] WARNING: ${unknown.length} applied migration(s) in the ledger do not match any journal entry — the database may have been migrated from a different branch. Investigate before deploying.`);
    }

    if (pending.length === 0) {
      log("[migrate-prod] database is up to date — nothing to do");
      return { status: "up-to-date", pending, applied };
    }

    if (dryRun) {
      log("\n[migrate-prod] DRY RUN — the following SQL WOULD be applied (nothing was executed):\n");
      for (const m of pending) {
        log(`-- ── migration: ${m.tag}`);
        for (const statement of m.sql) log(statement.endsWith(";") ? statement : `${statement};`);
      }
      log("\n[migrate-prod] dry run complete. Re-run without --dry-run (and with CONFIRM_BACKUP=yes) to apply.");
      return { status: "dry-run", pending, applied };
    }

    // === W46 platform-p2 (PLT-22) === pre-migration logical dump BEFORE any
    // statement is applied (auto|required|off via PRE_MIGRATION_DUMP).
    const dump = await runPreMigrationDump({ databaseUrl: opts.databaseUrl, env, log });
    log(`[migrate-prod] pre-migration dump status: ${dump.status}${dump.objectKey ? ` (${dump.objectKey})` : ""}`);
    // === END W46 platform-p2 (PLT-22) ===

    // ── Apply, one transaction per migration, stop on first error ─────────
    for (const m of pending) {
      log(`[migrate-prod] applying ${m.tag} ...`);
      try {
        await opts.db.applyMigration(m);
      } catch (err: any) {
        log(`[migrate-prod] ERROR applying ${m.tag}: ${err?.message ?? err}`);
        log(resumeInstructions(m.tag));
        throw err;
      }
      log(`[migrate-prod] applied ${m.tag}`);
    }

    // ── Post-apply verification ───────────────────────────────────────────
    const finalSet = new Set(await opts.db.appliedHashes());
    const missing = migrations.filter((m) => !finalSet.has(m.hash)).map((m) => m.tag);
    if (missing.length > 0) throw new MigrationVerificationError(missing);
    log(`[migrate-prod] verification OK — all ${migrations.length} journal migrations recorded in ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`);
    return { status: "applied", pending, applied };
  } finally {
    await opts.db.close();
  }
}

// ─── CLI entry ──────────────────────────────────────────────────────────────
const invokedAsScript = !!process.argv[1] && /migrate-prod(\.ts)?$/.test(process.argv[1]);
if (invokedAsScript) {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    console.error("[migrate-prod] FATAL: DATABASE_URL (or POSTGRES_URL) is not set");
    process.exit(1);
  }
  runMigrations({ db: createPostgresMigrateDb(url), dryRun, databaseUrl: url })
    .then((result) => {
      if (result.status === "backup-refused") process.exit(2);
    })
    .catch((err) => {
      if (err instanceof MigrationLockError || err instanceof MigrationVerificationError) {
        console.error(`[migrate-prod] FATAL: ${err.message}`);
      } else if (!(err instanceof BackupNotConfirmedError)) {
        console.error("[migrate-prod] FAILED:", err?.message ?? err);
      }
      process.exit(1);
    });
}
