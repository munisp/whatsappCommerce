/**
 * === W39 durability (Coder A, PLT-2) ===
 * J265 — TigerBeetle backup: offline copy script + honest documentation.
 *
 * 1. scripts/backup/tigerbeetle-backup.sh exists, is non-empty, and performs
 *    the SAFE offline path: scale to 0 → copy data file off the PVC →
 *    scale back to 1.
 * 2. The script honestly scopes itself (crash-consistent caveat for live
 *    copies; 3-replica cluster required for production durability).
 * 3. docs/RESILIENCE.md documents both TB backup paths (offline script +
 *    crash-consistent CronJob #43) and states that backups complement, never
 *    replace, VSR replication.
 */
import fs from "node:fs";
import path from "node:path";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();

export const journey: Journey = {
  id: "J265",
  name: "TigerBeetle backup script + honest doc",
  feature: "PLT-2 TB data backup (offline copy + honest caveats)",
  async run(_world: World) {
    const scriptPath = path.join(ROOT, "scripts/backup/tigerbeetle-backup.sh");
    assert(fs.existsSync(scriptPath), "scripts/backup/tigerbeetle-backup.sh missing");
    const script = fs.readFileSync(scriptPath, "utf8");
    assert(script.trim().length > 0, "TB backup script is empty");

    // Offline (safe) flow: scale down before touching the RWO volume, restore after.
    assert(script.includes("scale deploy/") && script.includes("--replicas=0"),
      "script scales TB to 0 before copying");
    assert(script.includes("--replicas=1"), "script scales TB back to 1 after copying");
    assert(script.includes("0_0.tigerbeetle"), "script copies the TB data file");
    assert(script.includes("tigerbeetle-data"), "script sources from the tigerbeetle-data PVC");

    // Honest scoping.
    assert(script.includes("crash-consistent"), "script documents crash-consistent risk of live copies");
    assert(script.includes("3-replica"), "script notes production needs a 3-replica TB cluster");

    // Doc covers both paths + replication primacy.
    const doc = fs.readFileSync(path.join(ROOT, "docs/RESILIENCE.md"), "utf8");
    assert(doc.includes("tigerbeetle-backup.sh"), "RESILIENCE.md references the offline copy script");
    assert(doc.includes("crash-consistent"), "RESILIENCE.md documents the crash-consistent CronJob path");
    assert(doc.includes("never\n  replace, replication") || /never\s+replace,\s*replication/.test(doc),
      "RESILIENCE.md states backups complement, never replace, replication");
  },
};
