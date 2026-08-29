/**
 * === W35 infra-receivers (Coder D) ===
 * J229 — migration 0116 telemetry_component_status.
 *
 *  1. Journal re-chained: _journal.json has idx 116 after 115 and the 0116
 *     snapshot prevId == the 0115 snapshot id (prevId chain intact).
 *  2. PGlite apply test: a FRESH standalone PGlite applies
 *     drizzle/0116_telemetry_component_status.sql (statement-breakpoint
 *     split, same as world.ts) and the table is queryable (insert/select
 *     round-trip incl. nullable tenant_id + jsonb payload).
 *  3. The sim world DB (all migrations applied at boot) also has the table.
 *  4. drizzle/schema.ts exports the table definition (additivity guard:
 *     telemetry_tenant_allowlist still present).
 */
import fs from "node:fs";
import path from "node:path";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();

export const journey: Journey = {
  id: "J229",
  name: "mig 0116 telemetry_component_status: journal chain + PGlite apply",
  feature: "W35 infra-receivers: additive migration 0116",
  async run(world: World) {
    // 1. Journal + snapshot chain.
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
    const tags = journal.entries.map((e: any) => e.tag);
    assert(tags.includes("0116_telemetry_component_status"), "journal: 0116 entry missing");
    const i116 = tags.indexOf("0116_telemetry_component_status");
    assert(tags[i116 - 1] === "0115_telemetry_tenant_allowlist", "journal: 0116 must follow 0115");
    const s115 = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/0115_telemetry_tenant_allowlist_snapshot.json"), "utf8"));
    const s116 = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/0116_telemetry_component_status_snapshot.json"), "utf8"));
    assert(s116.prevId === s115.id, `snapshot prevId re-chain broken (${s116.prevId} != ${s115.id})`);
    assert(s116.id !== s115.id, "snapshot id must be fresh");
    assert(s116.tables["public.telemetry_component_status"], "snapshot: table missing");
    assert(s116.tables["public.telemetry_tenant_allowlist"], "snapshot must be cumulative (0115 table kept)");

    // 2. Standalone PGlite apply.
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.waitReady;
    try {
      const sqlText = fs.readFileSync(path.join(ROOT, "drizzle/0116_telemetry_component_status.sql"), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        await pg.exec(stmt);
      }
      await pg.query(
        `INSERT INTO telemetry_component_status (tenant_id, component, status, payload) VALUES ($1, $2, $3, $4)`,
        [null, "otel-collector", "down", JSON.stringify({ error: "connection refused" })],
      );
      await pg.query(
        `INSERT INTO telemetry_component_status (tenant_id, component, status) VALUES ($1, $2, $3)`,
        ["tenant-j229", "grafana", "up"],
      );
      const rows = await pg.query(`SELECT component, status, tenant_id, payload FROM telemetry_component_status ORDER BY id`);
      assert(rows.rows.length === 2, `expected 2 rows, got ${rows.rows.length}`);
      const first = rows.rows[0] as any;
      assert(first.component === "otel-collector" && first.status === "down", "row 1 round-trip failed");
      assert(first.tenant_id === null, "tenant_id must be nullable (platform-scoped)");
      assert(first.payload?.error === "connection refused", "jsonb payload round-trip failed");
    } finally {
      await pg.close();
    }

    // 3. Sim world DB (boot applies all drizzle/*.sql) has the table.
    const t = await world.db.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'telemetry_component_status'`,
    );
    const rows = (t as any).rows ?? t;
    assert((rows as any[]).length === 1, "world DB missing telemetry_component_status (migration not applied at boot)");

    // 4. schema.ts additive export.
    const schema = await import("../../drizzle/schema");
    assert((schema as any).telemetryComponentStatus, "schema.ts: telemetryComponentStatus export missing");
    assert((schema as any).telemetryTenantAllowlist, "schema.ts: 0115 table regressed (additivity)");
  },
};
