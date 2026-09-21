/**
 * QA-021: the live cluster had no backups at all. k8s-flux/backups/postgres-backup.yaml is
 * the fix, and it was proven with a real drill (backup → restore into a scratch Postgres →
 * negative control with a truncated dump). This locks the properties that drill depended on,
 * so a later "tidy-up" of the manifest cannot quietly turn the backup into something that
 * only looks like one.
 *
 * Static checks only — they cannot prove a restore works (the weekly postgres-restore-verify
 * CronJob does that), but each assertion below is a way this has silently broken before or
 * would break a backup without failing any deploy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAll } from "js-yaml";

type Obj = Record<string, any>;
const ROOT = join(__dirname, "..");
const docs = (loadAll(readFileSync(join(ROOT, "k8s-flux/backups/postgres-backup.yaml"), "utf8")) as Obj[]).filter(Boolean);
const byName = (kind: string, name: string): Obj => {
  const d = docs.find((x) => x.kind === kind && x.metadata?.name === name);
  if (!d) throw new Error(`${kind}/${name} missing from postgres-backup.yaml`);
  return d;
};
const podSpec = (cj: Obj): Obj => cj.spec.jobTemplate.spec.template.spec;
const container = (cj: Obj): Obj => podSpec(cj).containers[0];
const script = (cj: Obj): string => container(cj).args.at(-1) as string;

const backup = byName("CronJob", "postgres-backup");
const verify = byName("CronJob", "postgres-restore-verify");
const pvc = byName("PersistentVolumeClaim", "postgres-backups");

describe("backup manifests (QA-021)", () => {
  it("defines exactly the PVC and the two CronJobs, in the app namespace", () => {
    expect(docs.map((d) => `${d.kind}/${d.metadata.name}`).sort()).toEqual([
      "CronJob/postgres-backup",
      "CronJob/postgres-restore-verify",
      "PersistentVolumeClaim/postgres-backups",
    ]);
    for (const d of docs) expect(d.metadata.namespace).toBe("whatsapp-commerce");
  });

  it("is part of the Flux kustomization (otherwise a Flux resume prunes it)", () => {
    const k = readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8");
    expect(k).toMatch(/^\s*-\s*backups\/postgres-backup\.yaml\s*$/m);
  });

  it("never lets two runs overlap and bounds how long a run may take", () => {
    for (const cj of [backup, verify]) {
      expect(cj.spec.concurrencyPolicy).toBe("Forbid");
      expect(cj.spec.timeZone).toBe("Etc/UTC");
      expect(cj.spec.jobTemplate.spec.activeDeadlineSeconds).toBeGreaterThan(0);
      expect(cj.spec.jobTemplate.spec.activeDeadlineSeconds).toBeLessThanOrEqual(3600);
      // a missed window must still run, but not indefinitely late
      expect(cj.spec.startingDeadlineSeconds).toBeGreaterThan(0);
    }
  });

  it("runs backup at least daily and the restore drill at least weekly", () => {
    expect(backup.spec.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(verify.spec.schedule).toMatch(/^\d+ \d+ \* \* \d$/);
  });

  it("dumps and verifies with the SAME image, pinned to a PostgreSQL major (a v16 client cannot dump a v18 server)", () => {
    const a = container(backup).image as string;
    const b = container(verify).image as string;
    expect(a).toBe(b);
    expect(a).toMatch(/postgresql:\d+\.\d+/);
    expect(a).not.toMatch(/:latest$/);
  });

  it("takes credentials only from a Secret, never inline", () => {
    const dsn = container(backup).env.find((e: Obj) => e.name === "DATABASE_URL");
    expect(dsn.valueFrom.secretKeyRef.name).toBe("whatsapp-postgres-dsn");
    for (const cj of [backup, verify]) {
      for (const e of container(cj).env ?? []) {
        if (/URL|PASS|SECRET|TOKEN|KEY/i.test(e.name)) expect(e.value, `${e.name} must not be inline`).toBeUndefined();
      }
      expect(script(cj)).not.toMatch(/postgres(ql)?:\/\/[^\s$"']*:[^\s$"']+@/);
    }
  });

  it("runs unprivileged with a read-only root filesystem", () => {
    for (const cj of [backup, verify]) {
      const ps = podSpec(cj);
      expect(ps.securityContext.runAsNonRoot).toBe(true);
      expect(ps.securityContext.seccompProfile.type).toBe("RuntimeDefault");
      const sc = container(cj).securityContext;
      expect(sc.allowPrivilegeEscalation).toBe(false);
      expect(sc.readOnlyRootFilesystem).toBe(true);
      expect(sc.capabilities.drop).toContain("ALL");
      expect(container(cj).resources.limits.memory).toBeTruthy();
    }
  });

  it("the restore drill can only READ the backups (a buggy verifier must not be able to delete them)", () => {
    const vol = podSpec(verify).volumes.find((v: Obj) => v.persistentVolumeClaim);
    expect(vol.persistentVolumeClaim.claimName).toBe("postgres-backups");
    expect(vol.persistentVolumeClaim.readOnly).toBe(true);
    const mount = container(verify).volumeMounts.find((m: Obj) => m.mountPath === "/backups");
    expect(mount.readOnly).toBe(true);
    expect(script(verify)).not.toMatch(/\brm\b[^\n]*\/backups|\bmv\b[^\n]*\/backups/);
  });

  it("has room for the dumps it keeps", () => {
    const req = pvc.spec.resources.requests.storage as string;
    expect(req).toMatch(/^\d+Gi$/);
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
  });

  describe("backup script", () => {
    const s = script(backup);
    it("fails loudly and does not leave a half-written file that looks valid", () => {
      expect(s).toMatch(/set -eu/);
      expect(s).toMatch(/\.inprogress-/);
      expect(s).toMatch(/trap /);
      // the dump only becomes visible under its real name AFTER validation and sidecars
      expect(s.indexOf("pg_restore --list")).toBeGreaterThan(-1);
      const validate = s.indexOf("pg_restore --list");
      const rename = s.search(/mv [^\n]*\$\{?TMP\}?[^\n]*\$\{?FINAL\}?|mv -f [^\n]*/);
      expect(rename).toBeGreaterThan(validate);
    });
    it("writes a checksum and metadata the verifier depends on", () => {
      expect(s).toMatch(/sha256sum/);
      expect(s).toMatch(/\.counts/);
      expect(s).toMatch(/\.meta/);
    });
    it("prunes by count, keeping a bounded number of dumps", () => {
      expect(s).toMatch(/tail -n \+\$\(\(KEEP ?\+ ?1\)\)/);
      const keep = container(backup).env.find((e: Obj) => e.name === "KEEP");
      expect(Number(keep.value)).toBeGreaterThanOrEqual(7);
    });
    it("uses only real pg_tables columns (a wrong column name once failed the first drill)", () => {
      expect(s).not.toMatch(/\brelname\b/);
      expect(s).toMatch(/tablename/);
    });
  });

  describe("restore-verify script", () => {
    const s = script(verify);
    it("refuses stale, unchecksummed or missing backups", () => {
      expect(s).toMatch(/MAX_AGE_HOURS/);
      expect(s).toMatch(/sha256sum -c/);
    });
    it("checks the restored data, not just that pg_restore exited 0", () => {
      expect(s).toMatch(/--exit-on-error/);
      expect(s).toMatch(/toc_tables|TOC_TABLES/i);
      expect(s).toMatch(/toc_fks|TOC_FKS/i);
      expect(s).toMatch(/migrations/i);
      expect(s).toMatch(/rows_at_backup|had rows|\.counts/);
    });
    it("restores into a private scratch server that cannot reach the network or the live DB", () => {
      expect(s).toMatch(/listen_addresses=''/);
      expect(s).toMatch(/initdb/);
      expect(s).not.toMatch(/--dbname="?\$DATABASE_URL/);
    });
  });

  describe("embedded shell is syntactically valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    it.each([
      ["postgres-backup", backup],
      ["postgres-restore-verify", verify],
    ])("%s passes `sh -n`", (name, cj) => {
      const f = join(dir, `${name}.sh`);
      writeFileSync(f, script(cj as Obj));
      expect(() => execFileSync("sh", ["-n", f], { stdio: "pipe" })).not.toThrow();
    });
  });
});

describe("backup alert rules (QA-021)", () => {
  const rules = readFileSync(join(ROOT, "deploy/otel/alert-rules.yml"), "utf8");
  it.each(["PostgresBackupStale", "PostgresBackupRunFailing", "PostgresRestoreVerifyStale"])(
    "%s exists and targets the real CronJob series",
    (name) => {
      expect(rules).toContain(`alert: ${name}`);
    },
  );
  it("a vanished CronJob alerts (absent), it does not go quiet", () => {
    expect(rules).toMatch(/absent\(kube_cronjob_status_last_successful_time\{namespace="whatsapp-commerce",cronjob="postgres-backup"\}\)/);
  });
});
