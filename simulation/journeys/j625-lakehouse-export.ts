// === W66 learning ===
/**
 * J625 — R8 lakehouse broadening (services/lakehouseExport.ts):
 *   1. Seeds rows in the broadened bronze sources (wallet_transactions,
 *      search_queries, nlp_sessions).
 *   2. runLakehouseExport exports them incrementally with per-table
 *      watermarks in lakehouse_export_watermarks (0184) and writes
 *      date-partitioned batch files.
 *   3. A second run exports 0 rows — watermark idempotency.
 *   4. A NEW row after the watermark is picked up by run 3 (incremental).
 *   5. /api/scheduled/lakehouse-export is registered and in the scheduler
 *      allowlist (J615 parity pattern).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J625",
  name: "lakehouse export: incremental watermark, date-partitioned output, idempotent re-run",
  feature: "W66 R8 lakehouse broadening",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { sql } = await import("drizzle-orm");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "j625-lakehouse-"));
    process.env.LAKEHOUSE_DATA_DIR = dataDir;
    try {
      // ── Seeds ──────────────────────────────────────────────────────────
      await world.db.insert(schema.searchQueries).values([
        { tenantId: TENANT_ID, channel: "wa", query: "j625 ankara", resultsCount: 3, zeroResult: false },
        { tenantId: TENANT_ID, channel: "wa", query: "j625 dragon fruit", resultsCount: 0, zeroResult: true },
      ]).onConflictDoNothing();
      // merchant_wallets.tenant_id is UNIQUE: in the full shared world an
      // earlier journey may already own the sim tenant's wallet — reuse it.
      const { eq } = await import("drizzle-orm");
      const [existingWallet] = await world.db.select({ id: schema.merchantWallets.id })
        .from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
      const walletId: string = existingWallet?.id ?? "w-j625";
      if (!existingWallet) {
        await world.db.insert(schema.merchantWallets).values({ id: walletId, tenantId: TENANT_ID }).onConflictDoNothing();
      }
      await world.db.execute(sql`
        INSERT INTO wallet_transactions (id, wallet_id, tenant_id, type, amount, balance_before, balance_after, currency, reference)
        VALUES ('11111111-1111-4111-8111-111111111625', ${walletId}, ${TENANT_ID}, 'escrow_credit', 100.00, 0, 100.00, 'NGN', 'j625-ref-1')
        ON CONFLICT DO NOTHING
      `);
      await world.db.execute(sql`
        INSERT INTO nlp_sessions (id, "tenantId", "waPhoneNumber", state, language)
        VALUES ('nlp-j625', ${TENANT_ID}, '2348062500001', 'browse', 'english')
        ON CONFLICT DO NOTHING
      `);

      const { runLakehouseExport } = await import("../../server/services/lakehouseExport");

      // ── Run 1: exports the seeded rows ─────────────────────────────────
      const run1 = await runLakehouseExport();
      assert(run1.status === "completed", `run1 status ${run1.status}`);
      const sq1 = run1.tables.find((t) => t.table === "search_queries")!;
      assert(sq1.rows >= 2, `search_queries exported ${sq1.rows}`);
      assert(sq1.file && fs.existsSync(sq1.file), "batch file written");
      assert(sq1.file!.includes(`${path.sep}dt=`), "date-partitioned path");
      const wt1 = run1.tables.find((t) => t.table === "wallet_transactions")!;
      assert(wt1.rows >= 1, `wallet_transactions exported ${wt1.rows}`);

      // Watermark rows exist
      const wms = await world.db.execute(sql`
        SELECT table_name FROM lakehouse_export_watermarks
        WHERE table_name IN ('search_queries', 'wallet_transactions', 'nlp_sessions')
      `).then((r: any) => (r.rows ?? r));
      assert((wms as any[]).length === 3, `watermarks ${(wms as any[]).length}`);

      // ── Run 2: nothing new → 0 rows (idempotent) ───────────────────────
      const run2 = await runLakehouseExport();
      assert(run2.totalRows === 0, `run2 total ${run2.totalRows}`);

      // ── Run 3: a new row lands after the watermark → incremental ───────
      await world.db.insert(schema.searchQueries).values({
        tenantId: TENANT_ID, channel: "web", query: "j625 shea butter", resultsCount: 0, zeroResult: true,
      }).onConflictDoNothing();
      const run3 = await runLakehouseExport();
      const sq3 = run3.tables.find((t) => t.table === "search_queries")!;
      assert(sq3.rows >= 1, `run3 search_queries ${sq3.rows}`);

      // ── Scheduler parity (J615 pattern) ────────────────────────────────
      const indexSrc = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf8");
      assert(indexSrc.includes('"/api/scheduled/lakehouse-export"'), "route registered");
      const schedSrc = fs.readFileSync(path.join(ROOT, "services/scheduler/scheduler.mjs"), "utf8");
      assert(schedSrc.includes("/api/scheduled/lakehouse-export"), "allowlist entry");
      // pipeline.py mirrors the registry (python path).
      const pySrc = fs.readFileSync(path.join(ROOT, "services/ml-stack/lakehouse/pipeline.py"), "utf8");
      assert(pySrc.includes("W66_EXPORT_TABLES") && pySrc.includes("run_bronze_export"), "pipeline.py broadened");
    } finally {
      delete process.env.LAKEHOUSE_DATA_DIR;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
};
