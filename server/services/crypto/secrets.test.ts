/**
 * W42 (PLT-9) — versioned secrets keyring: multi-version read, current-kid
 * write, v1 backward compatibility, fail-closed unknown kid.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  __resetSecretsKeyringForTest,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  needsReencrypt,
  reencryptIfOld,
  reencryptIfPlain,
} from "./secrets";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function legacyV1Encrypt(keyB64: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

const saved = { ...process.env };
afterEach(() => {
  process.env.SECRETS_MASTER_KEY = saved.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEYRING = saved.SECRETS_MASTER_KEYRING;
  process.env.SECRETS_MASTER_KEY_ID = saved.SECRETS_MASTER_KEY_ID;
  for (const k of ["SECRETS_MASTER_KEY", "SECRETS_MASTER_KEYRING", "SECRETS_MASTER_KEY_ID"]) {
    if (saved[k] === undefined) delete process.env[k];
  }
  __resetSecretsKeyringForTest();
});

describe("versioned secrets keyring", () => {
  it("writes v2:<kid> with the current kid and round-trips", () => {
    process.env.SECRETS_MASTER_KEYRING = JSON.stringify({ k1: KEY_A, k2: KEY_B });
    process.env.SECRETS_MASTER_KEY_ID = "k2";
    delete process.env.SECRETS_MASTER_KEY;
    __resetSecretsKeyringForTest();
    const ct = encryptSecret("hello");
    expect(ct.startsWith("v2:k2:")).toBe(true);
    expect(decryptSecret(ct)).toBe("hello");
    expect(isEncrypted(ct)).toBe(true);
  });

  it("reads legacy v1 ciphertexts via any keyring key after rotation", () => {
    const v1 = legacyV1Encrypt(KEY_A, "old-secret");
    process.env.SECRETS_MASTER_KEYRING = JSON.stringify({ k1: KEY_A, k2: KEY_B });
    process.env.SECRETS_MASTER_KEY_ID = "k2";
    delete process.env.SECRETS_MASTER_KEY;
    __resetSecretsKeyringForTest();
    expect(decryptSecret(v1)).toBe("old-secret");
    expect(needsReencrypt(v1)).toBe(true);
  });

  it("legacy SECRETS_MASTER_KEY alone still works (kid k1)", () => {
    process.env.SECRETS_MASTER_KEY = KEY_A;
    delete process.env.SECRETS_MASTER_KEYRING;
    delete process.env.SECRETS_MASTER_KEY_ID;
    __resetSecretsKeyringForTest();
    const ct = encryptSecret("x");
    expect(ct.startsWith("v2:k1:")).toBe(true);
    expect(decryptSecret(legacyV1Encrypt(KEY_A, "y"))).toBe("y");
  });

  it("fails closed on unknown kid and on v1 with no matching key", () => {
    process.env.SECRETS_MASTER_KEYRING = JSON.stringify({ k2: KEY_B });
    process.env.SECRETS_MASTER_KEY_ID = "k2";
    delete process.env.SECRETS_MASTER_KEY;
    __resetSecretsKeyringForTest();
    const orphan = legacyV1Encrypt(KEY_A, "lost");
    expect(() => decryptSecret(orphan)).toThrow(/any keyring key/);
    const ct = encryptSecret("z").replace("v2:k2:", "v2:gone:");
    expect(() => decryptSecret(ct)).toThrow(/unknown kid/);
  });

  it("reencryptIfOld migrates v1 → current kid, idempotent otherwise", () => {
    const v1 = legacyV1Encrypt(KEY_A, "rotate-me");
    process.env.SECRETS_MASTER_KEYRING = JSON.stringify({ k1: KEY_A, k2: KEY_B });
    process.env.SECRETS_MASTER_KEY_ID = "k2";
    delete process.env.SECRETS_MASTER_KEY;
    __resetSecretsKeyringForTest();
    const migrated = reencryptIfOld(v1) as string;
    expect(migrated.startsWith("v2:k2:")).toBe(true);
    expect(decryptSecret(migrated)).toBe("rotate-me");
    expect(reencryptIfOld(migrated)).toBe(migrated);
    expect(reencryptIfOld("plain")).toBe("plain");
    expect(reencryptIfOld(null)).toBe(null);
  });

  it("plaintext passthrough + reencryptIfPlain preserved", () => {
    process.env.SECRETS_MASTER_KEY = KEY_A;
    delete process.env.SECRETS_MASTER_KEYRING;
    delete process.env.SECRETS_MASTER_KEY_ID;
    __resetSecretsKeyringForTest();
    expect(decryptSecret("legacy-plaintext")).toBe("legacy-plaintext");
    expect(isEncrypted("legacy-plaintext")).toBe(false);
    const enc = reencryptIfPlain("legacy-plaintext") as string;
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe("legacy-plaintext");
  });
});
