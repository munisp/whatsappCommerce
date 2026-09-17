/**
 * server/services/crypto/rotateSweep.ts — W42 (PLT-9) master-key rotation sweep.
 *
 * Re-encrypts one secret type — odoo_integrations.apiKey (the sample secret
 * type chosen for W42) — onto the CURRENT keyring generation. Rows whose
 * apiKey is a legacy v1: envelope or a v2: envelope addressed to an old kid
 * are decrypted with the old generation and re-written with the current kid
 * (see crypto/secrets.ts). Plaintext rows are left untouched here — the
 * w10 encrypt-on-write path (reencryptIfPlain) owns that migration; this
 * sweep only moves ciphertext between key generations.
 *
 * Safe to run repeatedly (idempotent) and online: readers decrypt any
 * generation present in the keyring, so a half-swept table is fully
 * readable. Runbook: docs/SECRET_ROTATION.md.
 *
 * NEVER log secret values from this module — counts and row ids only.
 */
import { eq } from "drizzle-orm";
import { odooIntegrations } from "../../../drizzle/schema";
import { decryptSecret, encryptSecret, needsReencrypt } from "./secrets";

/** Minimal db surface the sweep needs (drizzle NodePg / PGlite both fit). */
interface SweepDb {
  select: (...args: any[]) => any;
  update: (...args: any[]) => any;
}

export interface RotateSweepResult {
  /** Rows inspected. */
  scanned: number;
  /** Rows re-encrypted onto the current key generation. */
  rotated: number;
  /** Rows skipped (already current, plaintext, or empty). */
  skipped: number;
  /** Row ids that failed to decrypt (left untouched — fail closed). */
  failedIds: string[];
}

/**
 * Re-encrypt odoo_integrations.apiKey values that sit on an old key
 * generation. `limit` bounds a single run so the sweep can be chunked from
 * the runbook; pass 0/undefined for all rows.
 */
export async function sweepOdooApiKeys(db: SweepDb, limit = 0): Promise<RotateSweepResult> {
  const rows = await db
    .select({ id: odooIntegrations.id, apiKey: odooIntegrations.apiKey })
    .from(odooIntegrations);

  const result: RotateSweepResult = { scanned: 0, rotated: 0, skipped: 0, failedIds: [] };
  for (const row of rows as Array<{ id: string; apiKey: string | null }>) {
    if (limit > 0 && result.rotated >= limit) break;
    result.scanned += 1;
    if (!row.apiKey || !needsReencrypt(row.apiKey)) {
      result.skipped += 1;
      continue;
    }
    try {
      const reencrypted = encryptSecret(decryptSecret(row.apiKey));
      await db
        .update(odooIntegrations)
        .set({ apiKey: reencrypted })
        .where(eq(odooIntegrations.id, row.id));
      result.rotated += 1;
    } catch (e: any) {
      // Fail closed: leave the row on the old generation and report the id.
      // A missing old key is an operator error (runbook step order) — never
      // silently drop or corrupt the ciphertext.
      console.warn(`[rotateSweep] odoo_integrations row ${row.id}: ${e?.message ?? e}`);
      result.failedIds.push(row.id);
    }
  }
  console.info(
    `[rotateSweep] odoo_integrations.apiKey: scanned=${result.scanned} ` +
      `rotated=${result.rotated} skipped=${result.skipped} failed=${result.failedIds.length}`,
  );
  return result;
}
