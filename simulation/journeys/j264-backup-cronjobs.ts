/**
 * === W39 durability (Coder A, PLT-1/PLT-8) ===
 * J264 — Backup CronJobs: nightly pg_dump (gzip, 7d retention, optional S3)
 * plus TB copy; schedules valid; honest-degrade documented.
 *
 * 1. k8s/backups.yaml parses; declares PVC postgres-backups and CronJobs
 *    cron-postgres-backup (#42) + cron-tigerbeetle-backup (#43), continuing
 *    the existing 41-CronJob sequence.
 * 2. Schedules are structurally valid 5-field cron expressions; the pg job is
 *    nightly (daily cadence fields).
 * 3. pg job gzips (gzip present in command), enforces 7-day retention
 *    (-mtime +7), and wires the env.example.txt S3_* block as OPTIONAL
 *    secretKeyRefs with an explicit honest-degrade log when S3 is unset.
 * 4. docs/RESILIENCE.md documents the PVC-only honest degrade and the
 *    7-day bucket lifecycle requirement.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAll as yamlLoadAll } from "js-yaml";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();

/** Structural cron check (not a full parser — honest scope): 5 fields,
 *  each composed of digits, *, comma, dash, slash. */
function assertValidCron(expr: string, label: string): void {
  const fields = expr.trim().split(/\s+/);
  assert(fields.length === 5, `${label}: cron must have 5 fields (got "${expr}")`);
  for (const f of fields) {
    assert(/^[0-9*,\-/]+$/.test(f), `${label}: bad cron field "${f}" in "${expr}"`);
  }
}

export const journey: Journey = {
  id: "J264",
  name: "backup CronJobs: nightly pg_dump gzip + 7d retention + S3 honest degrade",
  feature: "PLT-1/PLT-8 backup CronJobs #42/#43",
  async run(_world: World) {
    const full = path.join(ROOT, "k8s/backups.yaml");
    assert(fs.existsSync(full), "k8s/backups.yaml missing");
    const raw = fs.readFileSync(full, "utf8");
    const docs = yamlLoadAll(raw).filter((d) => d != null);

    const pvc = docs.find((d: any) => d.kind === "PersistentVolumeClaim" && d.metadata?.name === "postgres-backups");
    assert(!!pvc, "backups.yaml declares PVC postgres-backups");

    const crons = docs.filter((d: any) => d.kind === "CronJob");
    assert(crons.length === 2, `expected 2 backup CronJobs (#42/#43), got ${crons.length}`);
    const pg = crons.find((c: any) => c.metadata?.name === "cron-postgres-backup");
    const tb = crons.find((c: any) => c.metadata?.name === "cron-tigerbeetle-backup");
    assert(!!pg && !!tb, "cron-postgres-backup and cron-tigerbeetle-backup present");

    // Valid schedules; pg is nightly (day-of-month/month/day-of-week all '*').
    assertValidCron(pg.spec.schedule, "cron-postgres-backup");
    assertValidCron(tb.spec.schedule, "cron-tigerbeetle-backup");
    const [, , dom, mon, dow] = pg.spec.schedule.trim().split(/\s+/);
    assert(dom === "*" && mon === "*" && dow === "*", `pg backup must run nightly (got "${pg.spec.schedule}")`);
    assert(pg.spec.concurrencyPolicy === "Forbid", "pg backup concurrencyPolicy Forbid");

    // Job content: gzip, 7d retention, optional S3 wiring + honest degrade.
    const container = pg.spec.jobTemplate.spec.template.spec.containers[0];
    const script = (container.command ?? []).join("\n");
    assert(script.includes("pg_dump"), "pg job runs pg_dump");
    assert(script.includes("gzip"), "pg dump is gzipped");
    assert(script.includes("-mtime +7"), "7-day retention enforced (-mtime +7)");
    assert(script.includes("S3_BUCKET") && script.includes("HONEST-DEGRADE"),
      "S3 upload optional with explicit honest-degrade log");

    const env: any[] = container.env ?? [];
    for (const name of ["S3_BUCKET", "S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      const e = env.find((x) => x.name === name);
      assert(!!e, `pg job wires ${name}`);
      assert(e.valueFrom?.secretKeyRef?.optional === true, `${name} is optional (honest degrade)`);
    }
    // Secret keys map to the env.example.txt S3_* block.
    const s3Keys = env.filter((x) => x.name.startsWith("S3_") || x.name.startsWith("AWS_"))
      .map((x) => x.valueFrom.secretKeyRef.key);
    for (const k of ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
      assert(s3Keys.includes(k), `secret key ${k} referenced (env.example.txt S3 block)`);
    }

    // Both jobs write to the backup PVC; TB job is honestly labelled
    // crash-consistent and has 7d retention too.
    const tbScript = (tb.spec.jobTemplate.spec.template.spec.containers[0].command ?? []).join("\n");
    assert(tbScript.includes("crash-consistent") && tbScript.includes("-mtime +7"),
      "TB job honestly labelled crash-consistent with 7d retention");

    // env.example.txt really has the S3 block we wire to.
    const envExample = fs.readFileSync(path.join(ROOT, "env.example.txt"), "utf8");
    for (const v of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
      assert(envExample.includes(v), `env.example.txt documents ${v}`);
    }

    // Honest-degrade doc.
    const doc = fs.readFileSync(path.join(ROOT, "docs/RESILIENCE.md"), "utf8");
    assert(doc.includes("Backups (W39"), "RESILIENCE.md has the W39 backups section");
    assert(doc.toLowerCase().includes("honest degrade"), "PVC-only honest degrade documented");
    assert(doc.includes("7-day bucket lifecycle"), "bucket lifecycle retention documented");
  },
};
