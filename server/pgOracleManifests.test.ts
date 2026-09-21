/**
 * QA-032: the app's database was consolidated onto the shared CloudNativePG cluster `pg-oracle`.
 * k8s-flux/postgres-oracle/whatsapp-commerce-db.yaml declares the login role and the database.
 * These pin what must stay true of it, most of it learned the hard way during the move:
 *  - the role must NOT keep CREATEDB (it was granted once, only to rename a database, then revoked);
 *  - deleting the objects must never drop data (reclaim policy retain);
 *  - the database mirrors the source (UTF8, C/C, from template0) so restored indexes order identically;
 *  - the file lives in another team's namespace, so it must not be part of the app's Kustomization;
 *  - no credential is ever committed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

type Obj = Record<string, any>;
const ROOT = join(__dirname, "..");
const raw = readFileSync(join(ROOT, "k8s-flux/postgres-oracle/whatsapp-commerce-db.yaml"), "utf8");
const docs = (loadAll(raw) as Obj[]).filter(Boolean);
const role = docs.find((d) => d.kind === "DatabaseRole")!;
const db = docs.find((d) => d.kind === "Database")!;

describe("pg-oracle role and database (QA-032)", () => {
  it("declares exactly one login role and one database, on pg-oracle", () => {
    expect(docs.map((d) => d.kind).sort()).toEqual(["Database", "DatabaseRole"]);
    for (const d of docs) {
      expect(d.metadata.namespace).toBe("postgres-oracle");
      expect(d.spec.cluster.name).toBe("pg-oracle");
      expect(d.spec.ensure).toBe("present");
    }
  });

  it("gives the role no privileges beyond logging in (CREATEDB was granted once to rename a database, then revoked)", () => {
    expect(role.spec.login).toBe(true);
    for (const attr of ["createdb", "createrole", "superuser", "replication", "bypassrls"]) {
      expect(role.spec[attr], `${attr} must not be granted`).not.toBe(true);
    }
    expect(role.spec.inRoles).toBeUndefined();
  });

  it("caps the role's connections so a runaway pool cannot starve the other tenants of a shared cluster", () => {
    expect(role.spec.connectionLimit).toBeGreaterThan(0);
    expect(role.spec.connectionLimit).toBeLessThanOrEqual(100);
  });

  it("takes the password from a Secret reference, never inline", () => {
    expect(role.spec.passwordSecret.name).toBe("whatsapp-commerce-db-credentials");
    const content = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(content).not.toMatch(/^\s*password\s*:/m);
    expect(content).not.toMatch(/postgres(ql)?:\/\/[^\s/:]+:[^\s@]+@/);
    // the header documents the DSN shape; it may only ever show a placeholder, never a value
    for (const m of raw.matchAll(/postgres(?:ql)?:\/\/[^\s/:]+:([^\s@]+)@/g)) expect(m[1]).toBe("<password>");
  });

  it("never drops data when the objects are deleted", () => {
    expect(role.spec.databaseRoleReclaimPolicy).toBe("retain");
    expect(db.spec.databaseReclaimPolicy).toBe("retain");
  });

  it("creates the database owned by the role, mirroring the source (UTF8, C/C, from template0)", () => {
    expect(db.spec.name).toBe("whatsapp_commerce");
    expect(db.spec.owner).toBe(role.spec.name);
    expect(db.spec.encoding).toBe("UTF8");
    expect(db.spec.localeCollate).toBe("C");
    expect(db.spec.localeCType).toBe("C");
    expect(db.spec.template).toBe("template0");
  });

  it("is not part of the app's Kustomization: it lives in another team's namespace", () => {
    expect(readFileSync(join(ROOT, "k8s-flux/kustomization.yaml"), "utf8")).not.toMatch(/postgres-oracle/);
  });

  it("warns whoever re-applies it that ensure=present ADOPTS an existing database or role instead of refusing", () => {
    expect(raw).toMatch(/adopted, not refused/);
  });
});
