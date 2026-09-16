/**
 * === W39 durability (Coder A, PLT-1/PLT-2) ===
 * J263 — Stateful data volumes are PVC-backed, not emptyDir.
 *
 * 1. k8s/postgres.yaml and k8s/tigerbeetle.yaml parse as multi-doc YAML.
 * 2. Each declares a PersistentVolumeClaim (postgres-data 10Gi /
 *    tigerbeetle-data 5Gi, RWO) AND the pod's data volume references it via
 *    persistentVolumeClaim (no emptyDir on the data volume).
 * 3. No `emptyDir` remains on any volume mounted at a stateful data path
 *    (/var/lib/postgresql/data, /data) — ephemeral scratch (tmp/run) stays
 *    emptyDir by documented design.
 * 4. kustomization.yaml still references postgres.yaml, tigerbeetle.yaml and
 *    the new backups.yaml.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAll as yamlLoadAll } from "js-yaml";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();

function readDocs(rel: string): any[] {
  const full = path.join(ROOT, rel);
  assert(fs.existsSync(full), `${rel} missing`);
  return yamlLoadAll(fs.readFileSync(full, "utf8")).filter((d) => d != null);
}

function findPvcDoc(docs: any[], name: string): any {
  return docs.find((d) => d.kind === "PersistentVolumeClaim" && d.metadata?.name === name);
}

function findDeployDoc(docs: any[]): any {
  return docs.find((d) => d.kind === "Deployment");
}

function podSpec(deploy: any): any {
  return deploy?.spec?.template?.spec ?? {};
}

export const journey: Journey = {
  id: "J263",
  name: "stateful data volumes are PVC-backed (no emptyDir)",
  feature: "PLT-1/PLT-2 emptyDir → PVC for postgres + tigerbeetle",
  async run(_world: World) {
    // --- postgres ---
    const pgDocs = readDocs("k8s/postgres.yaml");
    const pgPvc = findPvcDoc(pgDocs, "postgres-data");
    assert(!!pgPvc, "postgres.yaml declares PVC postgres-data");
    assert(pgPvc.spec.accessModes?.includes("ReadWriteOnce"), "postgres-data PVC is RWO");
    assert(!!pgPvc.spec.resources?.requests?.storage, "postgres-data PVC requests storage");

    const pgDeploy = findDeployDoc(pgDocs);
    assert(!!pgDeploy, "postgres Deployment still present (minimal-change path)");
    const pgVols: any[] = podSpec(pgDeploy).volumes ?? [];
    const pgData = pgVols.find((v) => v.name === "postgres-data");
    assert(!!pgData?.persistentVolumeClaim, "postgres-data volume references a PVC");
    assert(pgData.persistentVolumeClaim.claimName === "postgres-data", "postgres-data claim name matches");
    assert(!("emptyDir" in pgData), "postgres-data must not be emptyDir");

    // No emptyDir on any volume mounted at the PG data path.
    const pgMounts: any[] = podSpec(pgDeploy).containers?.[0]?.volumeMounts ?? [];
    for (const m of pgMounts) {
      if (m.mountPath.startsWith("/var/lib/postgresql/data")) {
        const vol = pgVols.find((v) => v.name === m.name);
        assert(vol && !("emptyDir" in vol), `emptyDir still backing PG data mount ${m.mountPath}`);
      }
    }

    // --- tigerbeetle ---
    const tbDocs = readDocs("k8s/tigerbeetle.yaml");
    const tbPvc = findPvcDoc(tbDocs, "tigerbeetle-data");
    assert(!!tbPvc, "tigerbeetle.yaml declares PVC tigerbeetle-data");
    assert(tbPvc.spec.accessModes?.includes("ReadWriteOnce"), "tigerbeetle-data PVC is RWO");
    assert(!!tbPvc.spec.resources?.requests?.storage, "tigerbeetle-data PVC requests storage");

    const tbDeploy = findDeployDoc(tbDocs);
    const tbVols: any[] = podSpec(tbDeploy).volumes ?? [];
    const tbData = tbVols.find((v) => v.name === "tigerbeetle-data");
    assert(!!tbData?.persistentVolumeClaim, "tigerbeetle-data volume references a PVC");
    assert(tbData.persistentVolumeClaim.claimName === "tigerbeetle-data", "tigerbeetle-data claim name matches");
    assert(!("emptyDir" in tbData), "tigerbeetle-data must not be emptyDir");

    const tbContainers = [...(podSpec(tbDeploy).containers ?? []), ...(podSpec(tbDeploy).initContainers ?? [])];
    for (const c of tbContainers) {
      for (const m of c.volumeMounts ?? []) {
        if (m.mountPath === "/data") {
          const vol = tbVols.find((v) => v.name === m.name);
          assert(vol && !("emptyDir" in vol), `emptyDir still backing TB /data mount in ${c.name}`);
        }
      }
    }

    // --- kustomization wiring ---
    const kust = fs.readFileSync(path.join(ROOT, "k8s/kustomization.yaml"), "utf8");
    for (const f of ["postgres.yaml", "tigerbeetle.yaml", "backups.yaml"]) {
      assert(kust.includes(`- ${f}`), `kustomization.yaml references ${f}`);
    }
  },
};
