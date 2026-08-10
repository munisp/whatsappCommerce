/**
 * Tests for scripts/migrate-prod.ts — journal↔ledger diff logic, dry-run
 * no-apply, the CONFIRM_BACKUP gate, stop-on-first-error, and post-apply
 * verification. Uses an injected in-memory MigrateDb; no real database.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeApplied,
  computePending,
  MigrateDb,
  MigrationVerificationError,
  readJournalMigrations,
  runMigrations,
} from "../scripts/migrate-prod";

function makeMigrationFolder(entries: { tag: string; sql: string; when?: number }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-prod-test-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((e, idx) => ({
      idx,
      version: "7",
      when: e.when ?? 1_700_000_000_000 + idx,
      tag: e.tag,
      breakpoints: true,
    })),
  };
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of entries) fs.writeFileSync(path.join(dir, `${e.tag}.sql`), e.sql);
  return dir;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** In-memory MigrateDb recording calls and (optionally) failing on a tag. */
function makeFakeDb(opts?: { appliedHashes?: string[]; failOnTag?: string; lockFails?: boolean }) {
  const state = {
    ledger: [...(opts?.appliedHashes ?? [])],
    applied: [] as string[],
    lockAcquired: false,
    closed: false,
  };
  const db: MigrateDb = {
    async prepareAndLock() {
      if (opts?.lockFails) throw new Error("lock held by another migrator");
      state.lockAcquired = true;
    },
    async appliedHashes() {
      return [...state.ledger];
    },
    async applyMigration(m) {
      if (opts?.failOnTag === m.tag) throw new Error(`boom in ${m.tag}`);
      state.ledger.push(m.hash);
      state.applied.push(m.tag);
    },
    async close() {
      state.closed = true;
    },
  };
  return { db, state };
}

const M1_SQL = 'CREATE TABLE "t1" ("id" serial primary key);--> statement-breakpoint\nCREATE INDEX "i1" ON "t1" ("id");';
const M2_SQL = 'ALTER TABLE "t1" ADD COLUMN "name" text;';

const TWO_MIGRATIONS = [
  { tag: "0000_first", sql: M1_SQL, when: 1000 },
  { tag: "0001_second", sql: M2_SQL, when: 2000 },
];

let folder: string;
beforeEach(() => {
  folder = makeMigrationFolder(TWO_MIGRATIONS);
});
afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe("readJournalMigrations / diff logic", () => {
  it("reads the journal, splits statements on breakpoints, hashes like drizzle", () => {
    const migrations = readJournalMigrations(folder);
    expect(migrations).toHaveLength(2);
    expect(migrations[0].tag).toBe("0000_first");
    expect(migrations[0].sql).toHaveLength(2); // two statements, breakpoint removed
    expect(migrations[0].hash).toBe(sha256(M1_SQL));
    expect(migrations[1].folderMillis).toBe(2000);
  });

  it("throws when a journal entry has no matching SQL file", () => {
    fs.rmSync(path.join(folder, "0001_second.sql"));
    expect(() => readJournalMigrations(folder)).toThrow(/0001_second/);
  });

  it("computePending returns journal entries absent from the ledger", () => {
    const migrations = readJournalMigrations(folder);
    const pending = computePending(migrations, new Set([sha256(M1_SQL)]));
    expect(pending.map((m) => m.tag)).toEqual(["0001_second"]);
    const applied = computeApplied(migrations, new Set([sha256(M1_SQL)]));
    expect(applied.map((m) => m.tag)).toEqual(["0000_first"]);
  });
});

describe("backup gate", () => {
  it("refuses to run without CONFIRM_BACKUP=yes and never touches the DB", async () => {
    const { db, state } = makeFakeDb();
    const logs: string[] = [];
    const result = await runMigrations({ db, folder, env: {}, log: (m) => logs.push(m) });
    expect(result.status).toBe("backup-refused");
    expect(state.lockAcquired).toBe(false); // no DB access at all
    expect(logs.join("\n")).toMatch(/CONFIRM_BACKUP=yes/);
  });

  it("dry-run is exempt from the backup gate", async () => {
    const { db } = makeFakeDb();
    const result = await runMigrations({ db, folder, dryRun: true, env: {}, log: () => {} });
    expect(result.status).toBe("dry-run");
  });
});

describe("dry run", () => {
  it("prints the pending SQL without applying anything", async () => {
    const { db, state } = makeFakeDb({ appliedHashes: [sha256(M1_SQL)] });
    const logs: string[] = [];
    const result = await runMigrations({
      db,
      folder,
      dryRun: true,
      env: { CONFIRM_BACKUP: "yes" },
      log: (m) => logs.push(m),
    });
    expect(result.status).toBe("dry-run");
    expect(result.pending.map((m) => m.tag)).toEqual(["0001_second"]);
    expect(state.applied).toEqual([]); // nothing applied
    expect(state.lockAcquired).toBe(true);
    expect(state.closed).toBe(true);
    const out = logs.join("\n");
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/ALTER TABLE "t1" ADD COLUMN "name" text;/);
    expect(out).not.toMatch(/CREATE TABLE "t1"/); // already-applied SQL not printed
  });

  it("reports up-to-date when nothing is pending", async () => {
    const { db, state } = makeFakeDb({ appliedHashes: [sha256(M1_SQL), sha256(M2_SQL)] });
    const result = await runMigrations({ db, folder, env: { CONFIRM_BACKUP: "yes" }, log: () => {} });
    expect(result.status).toBe("up-to-date");
    expect(state.applied).toEqual([]);
  });
});

describe("apply path", () => {
  it("applies pending migrations in journal order and verifies the ledger", async () => {
    const { db, state } = makeFakeDb();
    const result = await runMigrations({ db, folder, env: { CONFIRM_BACKUP: "yes" }, log: () => {} });
    expect(result.status).toBe("applied");
    expect(state.applied).toEqual(["0000_first", "0001_second"]);
    expect(state.closed).toBe(true);
  });

  it("stops on first error: earlier migrations stay applied, error rethrown, resume hint printed", async () => {
    const { db, state } = makeFakeDb({ failOnTag: "0001_second" });
    const logs: string[] = [];
    await expect(
      runMigrations({ db, folder, env: { CONFIRM_BACKUP: "yes" }, log: (m) => logs.push(m) }),
    ).rejects.toThrow(/boom in 0001_second/);
    expect(state.applied).toEqual(["0000_first"]); // first migration committed
    const out = logs.join("\n");
    expect(out).toMatch(/MIGRATION STOPPED at "0001_second"/);
    expect(out).toMatch(/resumes?\s+exactly at "0001_second"/i);
    expect(state.closed).toBe(true); // lock released even on failure
  });

  it("fails when post-apply verification finds a journal tag missing", async () => {
    const { db, state } = makeFakeDb();
    // Simulate a DB that silently drops ledger records.
    const origApply = db.applyMigration.bind(db);
    db.applyMigration = async (m) => {
      await origApply(m);
      state.ledger = state.ledger.filter((h) => h !== m.hash);
    };
    await expect(
      runMigrations({ db, folder, env: { CONFIRM_BACKUP: "yes" }, log: () => {} }),
    ).rejects.toThrow(MigrationVerificationError);
  });

  it("propagates lock failures without applying anything", async () => {
    const { db, state } = makeFakeDb({ lockFails: true });
    await expect(
      runMigrations({ db, folder, env: { CONFIRM_BACKUP: "yes" }, log: () => {} }),
    ).rejects.toThrow(/lock/);
    expect(state.applied).toEqual([]);
  });

  it("warns about ledger drift (applied hashes not in the journal)", async () => {
    const { db } = makeFakeDb({ appliedHashes: [sha256(M1_SQL), sha256(M2_SQL), "deadbeef".repeat(8)] });
    const logs: string[] = [];
    const result = await runMigrations({ db, folder, env: { CONFIRM_BACKUP: "yes" }, log: (m) => logs.push(m) });
    expect(result.status).toBe("up-to-date");
    expect(logs.join("\n")).toMatch(/do not match any journal entry/);
  });
});

// Silence the expected console noise from fallback paths in this file's tests.
vi.spyOn(console, "warn").mockImplementation(() => {});
