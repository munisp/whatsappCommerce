// === W46 platform-p2 ===
/**
 * J424 — PLT-21 (scheduled-payment claim uses the DB clock: execute_at <=
 * now() inside the guarded UPDATE) + PLT-22 (pre-migration logical dump step
 * in migrate-prod with off/auto/required modes + object-storage upload).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J424",
  name: "DB-clock claim guard + pre-migration dump step",
  feature: "platform-p2: PLT-21 + PLT-22",
  async run() {
    // ── PLT-21 source contract: DB clock inside the guarded UPDATE ───────
    const sp = await readFile(`${repoRoot}/server/services/scheduledPayments.ts`, "utf8");
    assertIncludes(sp, "${scheduledPayments.executeAt} <= now()", "guarded UPDATE uses DB clock now()");
    // W46 merger fix (H's gates never ran): the candidate pre-filter ALSO
    // textually contains the DB-clock predicate, so indexOf ordering was
    // unsatisfiable. Scope the check to the claim UPDATE block itself:
    // `.set({ status: "claimed" … })` followed (within the same statement)
    // by the DB-clock predicate in its .where(...).
    const updateIdx = sp.indexOf('.set({ status: "claimed"');
    assert(updateIdx > 0, "claim UPDATE found");
    const claimBlock = sp.slice(updateIdx, updateIdx + 1200);
    assert(claimBlock.includes("${scheduledPayments.executeAt} <= now()"),
      "DB-clock predicate sits INSIDE the claim UPDATE");
    // W46 merge-close: the JS-clock half of the pre-filter threw
    // DrizzleQueryError on the PGlite/postgres.js sim stack — the pre-filter
    // is DB-clock ONLY (CURRENT_TIMESTAMP), matching the authoritative guard.
    assertIncludes(sp, "${scheduledPayments.executeAt} <= CURRENT_TIMESTAMP", "candidate pre-filter uses the DB clock only");
    assert(!sp.includes("${scheduledPayments.executeAt} <= ${now}"),
      "no JS-clock predicate in the claim pre-filter (driver-safe)");

    // ── PLT-22 functional: dump modes ────────────────────────────────────
    const mig = await import("../../scripts/migrate-prod");
    const noop = () => {};
    const off = await mig.runPreMigrationDump({ env: { PRE_MIGRATION_DUMP: "off" }, log: noop });
    assert(off.status === "off", "off mode skips");
    const noUrl = await mig.runPreMigrationDump({ env: { PRE_MIGRATION_DUMP: "auto" }, log: noop });
    assert(noUrl.status === "skipped-no-url", "auto mode without DATABASE_URL warns+skips");
    let threw = false;
    try {
      await mig.runPreMigrationDump({ env: { PRE_MIGRATION_DUMP: "required" }, log: noop });
    } catch (e: any) {
      threw = e?.name === "PreMigrationDumpError";
    }
    assert(threw, "required mode without DATABASE_URL aborts (fail-closed)");

    // ── PLT-22 source contract: dump runs BEFORE the apply loop ──────────
    const src = await readFile(`${repoRoot}/scripts/migrate-prod.ts`, "utf8");
    const dumpCall = src.indexOf("await runPreMigrationDump(");
    const applyLoop = src.indexOf("await opts.db.applyMigration(m)");
    assert(dumpCall > 0 && applyLoop > dumpCall, "dump executes before any migration is applied");
    assertIncludes(src, "pg_dump", "logical dump via pg_dump");
    assertIncludes(src, "--format=custom", "custom-format dump");
    assertIncludes(src, "PRE_MIGRATION_DUMP_S3_BUCKET", "object-storage upload knob");
    assertIncludes(src, "fPutObject", "minio upload path");
    assertIncludes(src, "databaseUrl: url", "CLI hands the DSN to the dump step");

    // ── docs ─────────────────────────────────────────────────────────────
    const runbook = await readFile(`${repoRoot}/docs/RUNBOOK_ROLLBACK.md`, "utf8");
    assertIncludes(runbook, "PLT-22", "runbook documents the dump step");
    assertIncludes(runbook, "pg_restore", "runbook documents the restore drill");
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "PRE_MIGRATION_DUMP=auto", "env.example documents dump modes");
  },
};
