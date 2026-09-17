/**
 * server/services/crypto/secrets.ts — envelope encryption for tenant secrets at rest.
 *
 * AES-256-GCM with a VERSIONED keyring of platform master keys (W42 / PLT-9).
 *
 * Storage formats:
 *   legacy:  v1:<iv_b64>:<tag_b64>:<ct_b64>           (single implicit key)
 *   current: v2:<kid>:<iv_b64>:<tag_b64>:<ct_b64>     (key-id addressed)
 *
 * Keyring resolution (parse once, cached):
 *   - SECRETS_MASTER_KEYRING: JSON object {"<kid>": "<base64-32B>"} or
 *     comma list "<kid>=<base64-32B>,<kid2>=<base64-32B>". May hold several
 *     generations of keys — OLD keys MUST stay in the ring until every
 *     ciphertext addressed to them has been re-encrypted (rotation runbook:
 *     docs/SECRET_ROTATION.md).
 *   - SECRETS_MASTER_KEY (legacy single key): registered under kid
 *     SECRETS_MASTER_KEY_ID (default "k1"). Still honored so existing
 *     deployments boot unchanged.
 *   - SECRETS_MASTER_KEY_ID: kid used for NEW writes. Defaults to the legacy
 *     kid when SECRETS_MASTER_KEY is set, else the sole keyring entry.
 *   - no usable key in production    → throw (fail closed; env.ts also
 *     boot-gates SECRETS_MASTER_KEY in its REQUIRED_BY_ENV list).
 *   - no usable key in dev/test      → deterministic dev-only key (kid "dev")
 *     derived from a fixed label, with a loud console warning.
 *
 * Read semantics (multi-version read):
 *   - v1:<…> ciphertexts are decrypted by TRYING EVERY key in the ring —
 *     GCM auth-tag verification makes a wrong key fail closed, so the first
 *     key that verifies is authoritative.
 *   - v2:<kid>:<…> ciphertexts are decrypted with the ring entry for <kid>;
 *     an unknown kid throws (fail closed, never partial plaintext).
 *   - Legacy plaintext values pass through unchanged, so rolling this out
 *     never breaks reads of pre-encryption rows.
 *
 * Write semantics: encryptSecret always writes v2 with the CURRENT kid.
 * needsReencrypt() identifies values still on an old generation so the
 * re-encrypt sweep (crypto/rotateSweep.ts) can migrate them.
 *
 * NEVER log secret values from this module.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, type CipherGCM } from "node:crypto";
import { isProd } from "../../_core/env";

const LEGACY_PREFIX = "v1:";
const V2_PREFIX = "v2:";
const IV_BYTES = 12; // 96-bit nonce, recommended for AES-GCM
/** Fixed label for the deterministic dev/test key — NOT a secret. */
const DEV_KEY_LABEL = "wacommerce-dev-only-secrets-master-key";
const DEV_KID = "dev";
/** Kid under which the legacy single SECRETS_MASTER_KEY is registered. */
const LEGACY_DEFAULT_KID = "k1";

interface Keyring {
  /** kid → raw 32-byte key. */
  keys: Map<string, Buffer>;
  /** kid used for new writes. */
  currentKid: string;
}

let cachedKeyring: Keyring | null | undefined; // undefined = not yet resolved
let devWarningEmitted = false;

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "base64");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

/** Parse SECRETS_MASTER_KEYRING: JSON {"kid":"b64"} or "kid=b64,kid2=b64". */
function parseKeyringEnv(raw: string | undefined): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return out;
  if (trimmed.startsWith("{")) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return out; // invalid JSON → treated as absent; resolver fails closed in prod
    }
    for (const [kid, val] of Object.entries(obj)) {
      const key = parseKey(typeof val === "string" ? val : undefined);
      if (kid.trim() && key) out.set(kid.trim(), key);
    }
    return out;
  }
  for (const pair of trimmed.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const kid = pair.slice(0, eq).trim();
    const key = parseKey(pair.slice(eq + 1));
    if (kid && key) out.set(kid, key);
  }
  return out;
}

function resolveKeyring(): Keyring {
  if (cachedKeyring !== undefined) {
    if (cachedKeyring) return cachedKeyring;
  } else {
    const keys = parseKeyringEnv(process.env.SECRETS_MASTER_KEYRING);
    const legacyKey = parseKey(process.env.SECRETS_MASTER_KEY);
    const explicitKid = (process.env.SECRETS_MASTER_KEY_ID ?? "").trim();
    const legacyKid = explicitKid || LEGACY_DEFAULT_KID;
    if (legacyKey && !keys.has(legacyKid)) keys.set(legacyKid, legacyKey);

    let currentKid = explicitKid;
    if (!currentKid) {
      if (legacyKey) currentKid = legacyKid;
      else if (keys.size === 1) currentKid = Array.from(keys.keys())[0];
    }

    if (keys.size === 0 && !isProd) {
      keys.set(DEV_KID, createHash("sha256").update(DEV_KEY_LABEL).digest());
      currentKid = DEV_KID;
      if (!devWarningEmitted) {
        devWarningEmitted = true;
        console.warn(
          "[secrets] WARNING: SECRETS_MASTER_KEY is unset/invalid — using a deterministic " +
            "DEV-ONLY key. Do NOT use this outside development/test; set SECRETS_MASTER_KEY " +
            "(`openssl rand -base64 32`) in any real deployment.",
        );
      }
    }

    if (keys.size > 0 && currentKid && keys.has(currentKid)) {
      cachedKeyring = { keys, currentKid };
    } else {
      cachedKeyring = null; // memoize the failure (production misconfiguration)
    }
  }
  if (!cachedKeyring) {
    throw new Error(
      "[secrets] FATAL: no usable secrets keyring — set SECRETS_MASTER_KEY (base64 32 bytes) " +
        "or SECRETS_MASTER_KEYRING + SECRETS_MASTER_KEY_ID naming an existing kid. Refusing to " +
        "encrypt/decrypt tenant secrets.",
    );
  }
  return cachedKeyring;
}

function encryptWith(key: Buffer, plaintext: string): { iv: string; tag: string; ct: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decryptWith(key: Buffer, ivB64: string, tagB64: string, ctB64: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  // Throws on auth-tag verification failure — intentionally not caught by callers.
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

/** Encrypt a UTF-8 secret with the CURRENT key generation (v2:<kid>:…). */
export function encryptSecret(plaintext: string): string {
  const ring = resolveKeyring();
  const key = ring.keys.get(ring.currentKid)!;
  const { iv, tag, ct } = encryptWith(key, plaintext);
  return `${V2_PREFIX}${ring.currentKid}:${iv}:${tag}:${ct}`;
}

/** True when the stored value is in an encrypted envelope format (v1: or v2:). */
export function isEncrypted(stored: string): boolean {
  return (
    typeof stored === "string" && (stored.startsWith(LEGACY_PREFIX) || stored.startsWith(V2_PREFIX))
  );
}

/**
 * True when the value is encrypted with a NON-CURRENT key generation
 * (legacy v1: envelope, or v2: addressed to an old kid) and should be
 * re-encrypted by the rotation sweep. Plaintext and current-kid v2 values
 * return false.
 */
export function needsReencrypt(stored: string | null | undefined): boolean {
  if (!stored) return false;
  if (stored.startsWith(LEGACY_PREFIX)) return true;
  if (stored.startsWith(V2_PREFIX)) {
    const kid = stored.slice(V2_PREFIX.length).split(":", 1)[0];
    return kid !== resolveKeyring().currentKid;
  }
  return false;
}

/**
 * Decrypt a stored secret. Encrypted values (any generation present in the
 * keyring) are decrypted — auth-tag failure throws (fail closed, never
 * partial plaintext). Legacy plaintext values are returned as-is and NEVER
 * throw.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const ring = resolveKeyring();

  if (stored.startsWith(LEGACY_PREFIX)) {
    const parts = stored.slice(LEGACY_PREFIX.length).split(":");
    // iv/tag must be present; the ciphertext may legitimately be empty (a
    // zero-length plaintext encrypts to an empty ct).
    if (parts.length !== 3 || !parts[0] || !parts[1]) {
      throw new Error("[secrets] malformed encrypted secret (expected v1:<iv>:<tag>:<ct>)");
    }
    const [ivB64, tagB64, ctB64] = parts;
    // Multi-version read: try every ring key; the GCM auth tag fails closed
    // on wrong keys, so the first successful decryption is authoritative.
    let lastErr: unknown;
    for (const key of Array.from(ring.keys.values())) {
      try {
        return decryptWith(key, ivB64, tagB64, ctB64);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `[secrets] v1 ciphertext could not be decrypted with any keyring key ` +
        `(${ring.keys.size} tried) — the owning master key was likely rotated out ` +
        `before re-encryption. Cause: ${(lastErr as Error)?.message ?? lastErr}`,
    );
  }

  // v2:<kid>:<iv>:<tag>:<ct>
  const parts = stored.slice(V2_PREFIX.length).split(":");
  if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("[secrets] malformed encrypted secret (expected v2:<kid>:<iv>:<tag>:<ct>)");
  }
  const [kid, ivB64, tagB64, ctB64] = parts;
  const key = ring.keys.get(kid);
  if (!key) {
    throw new Error(
      `[secrets] v2 ciphertext addresses unknown kid "${kid}" — keep old keys in ` +
        `SECRETS_MASTER_KEYRING until all ciphertexts are re-encrypted (docs/SECRET_ROTATION.md).`,
    );
  }
  return decryptWith(key, ivB64, tagB64, ctB64);
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

/**
 * Re-encrypt a stored secret onto the CURRENT key generation when it is on
 * an old one (v1: or non-current kid). Idempotent; passthrough for
 * null/undefined and already-current values. Used by the rotation sweep.
 */
export function reencryptIfOld(stored: string | null | undefined): string | null | undefined {
  if (stored === null || stored === undefined) return stored;
  if (!needsReencrypt(stored)) return stored;
  return encryptSecret(decryptSecret(stored));
}

/** Test hook: drop the memoized keyring so env changes take effect. */
export function __resetSecretsKeyringForTest(): void {
  cachedKeyring = undefined;
}
