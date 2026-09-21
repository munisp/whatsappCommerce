/**
 * QA: rust/recon-worker/src/main.rs has raw SQL against payment_intents that the
 * TypeScript/Drizzle layer never sees, so schema drift there is invisible to
 * tsc and to every other test. Two real bugs lived in that SQL:
 *
 *  1. `SELECT ... status ...` decoded into a Rust String. status is the
 *     Postgres ENUM payment_intent_status; tokio-postgres cannot decode a
 *     custom enum into String and Row::get PANICS, so the whole reconciliation
 *     pass crashed as soon as any completed/failed intent existed in the last
 *     24h (it only passed against an empty table — which is how it was
 *     mis-diagnosed as "test contention").
 *  2. The orphan-repair query listed `'voided'` and `'ledger_drift'`, which are
 *     not labels of that enum, so Postgres rejected the statement on every run
 *     ("invalid input value for enum payment_intent_status") — the active
 *     repair of orphaned ledger reservations could never execute.
 *
 * This is a static consistency check between that SQL and the real enum.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paymentIntentStatusEnum } from "../drizzle/schema";

const VALID = new Set<string>(paymentIntentStatusEnum.enumValues);

/** Problems found in the raw SQL of a Rust source file that queries payment_intents. */
export function paymentIntentSqlProblems(src: string): string[] {
  const problems: string[] = [];
  // every r#"..."# raw SQL string that touches payment_intents
  for (const m of src.matchAll(/r#"([\s\S]*?)"#/g)) {
    const sql = m[1];
    if (!/FROM\s+payment_intents/i.test(sql)) continue;
    for (const inList of sql.matchAll(/\bstatus\s+IN\s*\(([^)]*)\)/gi)) {
      for (const lit of inList[1].matchAll(/'([^']*)'/g)) {
        if (!VALID.has(lit[1])) problems.push(`status literal '${lit[1]}' is not a payment_intent_status label`);
      }
    }
    // the selected status column must be cast to text (enum -> String)
    const select = sql.split(/\bFROM\b/i)[0];
    if (/\bstatus\b/i.test(select) && !/status::text/i.test(select)) {
      problems.push("selects the enum column `status` without ::text (Row::get::<String> panics on an enum)");
    }
  }
  return problems;
}

describe("recon-worker payment_intents SQL vs the real enum", () => {
  it("the current source is clean", () => {
    const src = readFileSync(join(__dirname, "../rust/recon-worker/src/main.rs"), "utf8");
    expect(paymentIntentSqlProblems(src)).toEqual([]);
  });

  it("negative control: the pre-fix SQL is caught (both bugs)", () => {
    const preFix = `
      let rows = client.query(r#"SELECT id::text, "tenantId", CAST(amount AS float8) as amount, status, "ledgerPendingId"
        FROM payment_intents WHERE status IN ('completed', 'failed')"#, &[]);
      let orphan = client.query(r#"SELECT id::text, status FROM payment_intents
        WHERE "ledgerPendingId" IS NOT NULL AND status IN ('pending', 'failed', 'voided', 'ledger_drift')"#, &[]);`;
    const problems = paymentIntentSqlProblems(preFix);
    expect(problems.some((p) => p.includes("'voided'"))).toBe(true);
    expect(problems.some((p) => p.includes("'ledger_drift'"))).toBe(true);
    expect(problems.filter((p) => p.includes("::text")).length).toBe(2);
  });

  it("the enum labels this depends on are what the migration created", () => {
    expect([...VALID].sort()).toEqual(["cancelled", "completed", "failed", "initiated", "pending", "refunded"]);
  });
});
