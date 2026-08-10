/**
 * server/services/crypto/secrets.ts — envelope encryption for tenant secrets at rest.
 *
 * AES-256-GCM with a single platform master key from env SECRETS_MASTER_KEY
 * (base64-encoded 32 bytes, generate with `openssl rand -base64 32`).
 *
 * Storage format:  v1:<iv_b64>:<tag_b64>:<ct_b64>
 *
 * Key resolution (parse once, cached):
 *   - SECRETS_MASTER_KEY set + valid   → that key.
 *   - missing/invalid in production    → throw (fail closed; env.ts also
 *     boot-gates SECRETS_MASTER_KEY in its REQUIRED_BY_ENV list).
 *   - missing/invalid in dev/test      → deterministic dev-only key derived
 *     from a fixed label, with a loud console warning. NEVER safe for prod.
 *
 * Read compatibility: decryptSecret passes legacy plaintext values through
 * unchanged (only `v1:` values are decrypted), so rolling this out never
 * breaks reads of pre-encryption rows. GCM auth-tag verification failure
 * fails closed (throws — never returns partial plaintext).
 *
 * NEVER log secret values from this module.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, type CipherGCM } from "node:crypto";
import { isProd } from "../../_core/env";

const VERSION_PREFIX = "v1:";
const IV_BYTES = 12; // 96-bit nonce, recommended for AES-GCM
/** Fixed label for the deterministic dev/test key — NOT a secret. */
const DEV_KEY_LABEL = "wacommerce-dev-only-secrets-master-key";

let cachedKey: Buffer | null | undefined; // undefined = not yet resolved
let devWarningEmitted = false;

function parseMasterKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

function resolveKey(): Buffer {
  if (cachedKey !== undefined) {
    if (cachedKey) return cachedKey;
  } else {
    cachedKey = parseMasterKey(process.env.SECRETS_MASTER_KEY);
    if (!cachedKey && !isProd) {
      cachedKey = createHash("sha256").update(DEV_KEY_LABEL).digest();
      if (!devWarningEmitted) {
        devWarningEmitted = true;
        console.warn(
          "[secrets] WARNING: SECRETS_MASTER_KEY is unset/invalid — using a deterministic " +
            "DEV-ONLY key. Do NOT use this outside development/test; set SECRETS_MASTER_KEY " +
            "(`openssl rand -base64 32`) in any real deployment.",
        );
      }
    }
    if (!cachedKey) {
      cachedKey = null; // memoize the failure too (production misconfiguration)
    }
  }
  if (!cachedKey) {
    throw new Error(
      "[secrets] FATAL: SECRETS_MASTER_KEY is unset or invalid (expected base64-encoded 32 bytes) " +
        "in a production environment — refusing to encrypt/decrypt tenant secrets.",
    );
  }
  return cachedKey;
}

/** Encrypt a UTF-8 secret. Throws when no usable master key is available. */
export function encryptSecret(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** True when the stored value is in the encrypted v1: envelope format. */
export function isEncrypted(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(VERSION_PREFIX);
}

/**
 * Decrypt a stored secret. `v1:` values are decrypted (auth-tag failure
 * throws — fail closed, never return partial plaintext). Legacy plaintext
 * values are returned as-is and NEVER throw.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const parts = stored.slice(VERSION_PREFIX.length).split(":");
  // iv/tag must be present; the ciphertext may legitimately be empty (a
  // zero-length plaintext encrypts to an empty ct).
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("[secrets] malformed encrypted secret (expected v1:<iv>:<tag>:<ct>)");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const key = resolveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  // Throws on auth-tag verification failure — intentionally not caught.
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Re-encrypt a stored secret if it is still plaintext. Passthrough for
 * null/undefined and already-encrypted values (idempotent).
 */
export function reencryptIfPlain(stored: string | null | undefined): string | null | undefined {
  if (stored === null || stored === undefined) return stored;
  if (isEncrypted(stored)) return stored;
  return encryptSecret(stored);
}
