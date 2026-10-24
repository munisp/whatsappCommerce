// === W66 learning ===
/**
 * lakehouseExport.ts — R8 lakehouse broadening (platform-side exporter).
 *
 * Exports the newly-broadened bronze sources (beyond payment_intents, which
 * the python pipeline already covers) to date-partitioned JSON batch files
 * under services/ml-stack/data/lakehouse/bronze/<table>/dt=YYYY-MM-DD/, with
 * a per-table watermark in lakehouse_export_watermarks (0184) so scheduled
 * runs are INCREMENTAL (watermark by updated_at where present, else
 * created_at) and idempotent (a re-run with no new rows exports 0).
 *
 * The python pipeline (services/ml-stack/lakehouse/pipeline.py) mirrors this
 * table registry and consumes the same watermark table, so either trigger
 * path (cron route → this service, or pipeline.py subprocess) advances the
 * same bronze layer without double-exporting.
 *
 * Discipline: fail-open telemetry (a table failure is logged and skipped,
 * never aborts the run), no money movement here at all, raw sql`` params
 * never carry JS Dates (ISO strings only) for PGlite compatibility.
 */
import { sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ExportTableDef {
  /** Physical table name (snake_case). */
  table: string;
  /** Watermark column, quoted for raw SQL (camelCase cols need quotes). */
  wmCol: string;
  /** Tenant column for optional per-tenant filtering (null = global table). */
  tenantCol?: string;
}

/** Bronze sources broadened by W66 R8 (payment_intents stays in pipeline.py). */
export const LAKEHOUSE_EXPORT_TABLES: ExportTableDef[] = [
  { table: "wallet_transactions", wmCol: "created_at", tenantCol: "tenant_id" },
  { table: "ui_events", wmCol: "created_at", tenantCol: "tenant_id" },
  { table: "search_queries", wmCol: "created_at", tenantCol: "tenant_id" },
  { table: "escrow_disputes", wmCol: "updated_at", tenantCol: "tenant_id" },
  { table: "dispute_outcome_features", wmCol: "created_at", tenantCol: "tenant_id" },
  { table: "pos_payment_sessions", wmCol: `"updatedAt"`, tenantCol: `"tenantId"` },
  { table: "agent_cico_transactions", wmCol: `"createdAt"`, tenantCol: `"agentTenantId"` },
  { table: "nlp_sessions", wmCol: `"lastActivityAt"`, tenantCol: `"tenantId"` },
  { table: "intent_misses", wmCol: "updated_at", tenantCol: "tenant_id" },
];

const BATCH_LIMIT = 5000;

function bronzeDir(): string {
  return process.env.LAKEHOUSE_DATA_DIR
    ?? path.resolve(process.cwd(), "services/ml-stack/data/lakehouse");
}

export interface TableExportResult {
  table: string;
  rows: number;
  watermark: string | null;
  file?: string;
  error?: string;
}

export interface LakehouseExportRun {
  status: "completed" | "partial" | "failed";
  tables: TableExportResult[];
  totalRows: number;
  durationMs: number;
}

async function readWatermark(db: Db, table: string): Promise<string> {
  const res = await db.execute(sql`
    SELECT watermark FROM lakehouse_export_watermarks WHERE table_name = ${table} LIMIT 1
  `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
  const row = (res as any[])[0];
  // Epoch fallback: first run exports everything.
  return row?.watermark ? new Date(row.watermark).toISOString() : "1970-01-01T00:00:00.000Z";
}

async function writeWatermark(db: Db, table: string, watermark: string, rows: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO lakehouse_export_watermarks (table_name, watermark, rows_exported, last_run_at)
    VALUES (${table}, ${watermark}::timestamp, ${rows}, now())
    ON CONFLICT (table_name) DO UPDATE SET
      watermark = EXCLUDED.watermark,
      rows_exported = lakehouse_export_watermarks.rows_exported + EXCLUDED.rows_exported,
      last_run_at = now()
  `).catch((e: any) => console.warn(`[lakehouse-export] watermark write failed for ${table} (fail-open):`, e?.message));
}

/** Export one table incrementally. Never throws. */
export async function exportTable(db: Db, def: ExportTableDef, opts: { tenantId?: string } = {}): Promise<TableExportResult> {
  try {
    const since = await readWatermark(db, def.table);
    const tenantFilter = opts.tenantId && def.tenantCol
      ? sql` AND ${sql.raw(def.tenantCol)} = ${opts.tenantId}`
      : sql``;
    const res = await db.execute(sql`
      SELECT * FROM ${sql.raw(def.table)}
      WHERE ${sql.raw(def.wmCol)} > ${since}::timestamp
      ${tenantFilter}
      ORDER BY ${sql.raw(def.wmCol)} ASC
      LIMIT ${BATCH_LIMIT}
    `).then((r: any) => (r.rows ?? r));
    const rows = (res as any[]) ?? [];
    if (rows.length === 0) {
      return { table: def.table, rows: 0, watermark: null };
    }

    // Date-partitioned output: bronze/<table>/dt=YYYY-MM-DD/batch-<wm>.json
    const wmRaw = rows[rows.length - 1][def.wmCol.replace(/"/g, "")];
    const wmDate = new Date(wmRaw);
    const day = wmDate.toISOString().slice(0, 10);
    const dir = path.join(bronzeDir(), "bronze", def.table, `dt=${day}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `batch-${wmDate.getTime()}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));

    await writeWatermark(db, def.table, wmDate.toISOString(), rows.length);
    return { table: def.table, rows: rows.length, watermark: wmDate.toISOString(), file };
  } catch (e: any) {
    console.warn(`[lakehouse-export] ${def.table} export failed (fail-open):`, e?.message);
    return { table: def.table, rows: 0, watermark: null, error: e?.message ?? "export failed" };
  }
}

/** Full incremental export across the W66 bronze registry. Never throws. */
export async function runLakehouseExport(opts: { tenantId?: string } = {}): Promise<LakehouseExportRun> {
  const t0 = Date.now();
  const db = await getDb();
  if (!db) return { status: "failed", tables: [], totalRows: 0, durationMs: Date.now() - t0 };
  const tables: TableExportResult[] = [];
  for (const def of LAKEHOUSE_EXPORT_TABLES) {
    // Sequential batches: PGlite is single-connection.
    tables.push(await exportTable(db, def, opts));
  }
  const totalRows = tables.reduce((s, t) => s + t.rows, 0);
  const failed = tables.filter((t) => t.error).length;
  return {
    status: failed === 0 ? "completed" : failed === tables.length ? "failed" : "partial",
    tables,
    totalRows,
    durationMs: Date.now() - t0,
  };
}
// === END W66 learning ===
