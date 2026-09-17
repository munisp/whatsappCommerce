/**
 * === W42 secrets/auth (Coder B) ===
 * J312 — Secrets master-key rotation: ciphertexts written under the OLD key
 * generation (legacy v1: envelope) still decrypt after rotation
 * (multi-version read), new writes use the CURRENT kid (v2:<kid>:…), and the
 * re-encrypt sweep migrates odoo_integrations.apiKey onto the new generation.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

/** Craft a legacy v1: envelope exactly as the pre-W42 writer produced. */
function legacyV1Encrypt(keyB64: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export const journey: Journey = {
  id: "J312",
  name: "Secrets rotation reads old+new generations",
  feature: "versioned keyring: multi-version read, current-kid write, re-encrypt sweep",
  async run(world: World) {
    const secrets = await import("../../server/services/crypto/secrets");
    const saved = {
      key: process.env.SECRETS_MASTER_KEY,
      ring: process.env.SECRETS_MASTER_KEYRING,
      kid: process.env.SECRETS_MASTER_KEY_ID,
    };
    try {
      // Phase 1 — pre-rotation world: single legacy key k1 (KEY_A).
      process.env.SECRETS_MASTER_KEY = KEY_A;
      delete process.env.SECRETS_MASTER_KEYRING;
      delete process.env.SECRETS_MASTER_KEY_ID;
      secrets.__resetSecretsKeyringForTest();
      const oldGen = legacyV1Encrypt(KEY_A, "odoo-api-key-xyz");

      // Phase 2 — rotate: keyring holds k1 (old) + k2 (new), writes use k2.
      process.env.SECRETS_MASTER_KEYRING = JSON.stringify({ k1: KEY_A, k2: KEY_B });
      process.env.SECRETS_MASTER_KEY_ID = "k2";
      delete process.env.SECRETS_MASTER_KEY;
      secrets.__resetSecretsKeyringForTest();

      // Multi-version read: the old-generation ciphertext still decrypts.
      assert(secrets.decryptSecret(oldGen) === "odoo-api-key-xyz", "v1 ciphertext readable after rotation");
      // Current-version write: new envelopes address the new kid.
      const newGen = secrets.encryptSecret("fresh-secret");
      assert(newGen.startsWith("v2:k2:"), `new writes use current kid (got ${newGen.slice(0, 6)}…)`);
      assert(secrets.decryptSecret(newGen) === "fresh-secret", "v2 round-trips");
      assert(secrets.needsReencrypt(oldGen) === true, "old generation flagged for sweep");
      assert(secrets.needsReencrypt(newGen) === false, "current generation not flagged");

      // Phase 3 — re-encrypt sweep migrates odoo_integrations.apiKey.
      const schema = await import("../../drizzle/schema");
      const { sweepOdooApiKeys } = await import("../../server/services/crypto/rotateSweep");
      const rowId = `j312-${Date.now()}`;
      await world.db.insert(schema.odooIntegrations).values({
        id: rowId,
        // Unique tenant id: odoo_integrations.tenantId is UNIQUE and the sim
        // tenant may already hold a row from earlier journeys.
        tenantId: rowId,
        baseUrl: "https://odoo.j312.local",
        database: "j312",
        username: "svc",
        apiKey: oldGen,
      }).onConflictDoNothing();
      const res = await sweepOdooApiKeys(world.db as any);
      assert(res.failedIds.length === 0, `sweep had no failures (got ${res.failedIds.join(",")})`);
      assert(res.rotated >= 1, "sweep rotated at least our row");
      const [row] = await world.db.select().from(schema.odooIntegrations).where(eq(schema.odooIntegrations.id, rowId));
      assert(row.apiKey.startsWith("v2:k2:"), "swept row now on current kid");
      assert(secrets.decryptSecret(row.apiKey) === "odoo-api-key-xyz", "swept row decrypts to the same secret");
    } finally {
      // Restore env so later journeys see the unrotated world.
      if (saved.key === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = saved.key;
      if (saved.ring === undefined) delete process.env.SECRETS_MASTER_KEYRING; else process.env.SECRETS_MASTER_KEYRING = saved.ring;
      if (saved.kid === undefined) delete process.env.SECRETS_MASTER_KEY_ID; else process.env.SECRETS_MASTER_KEY_ID = saved.kid;
      secrets.__resetSecretsKeyringForTest();
    }
  },
};
