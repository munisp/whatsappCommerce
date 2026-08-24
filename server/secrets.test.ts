/**
 * secrets.test.ts — envelope encryption for tenant secrets at rest (w10).
 *
 * Covers the AES-256-GCM crypto primitive (server/services/crypto/secrets.ts):
 * round-trip, v1: envelope format, random IVs, tamper detection (fail closed),
 * wrong-key rejection, legacy plaintext passthrough, reencryptIfPlain
 * idempotency + null/undefined passthrough, the dev/test fallback key warning,
 * a no-secret-in-logs guard, and the production env boot gate for
 * SECRETS_MASTER_KEY (server/_core/env.ts REQUIRED_BY_ENV pattern).
 *
 * The suite injects a deterministic test master key via SECRETS_MASTER_KEY so
 * every test exercises the real env-key path (never the dev fallback, except
 * the one test that explicitly covers the fallback).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  reencryptIfPlain,
} from "./services/crypto/secrets";

const TEST_KEY_B64 = Buffer.alloc(32, 11).toString("base64");
const OTHER_KEY_B64 = Buffer.alloc(32, 22).toString("base64");

beforeAll(() => {
  vi.stubEnv("SECRETS_MASTER_KEY", TEST_KEY_B64);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// ─── Round-trip & format ─────────────────────────────────────────────────────

describe("encryptSecret/decryptSecret", () => {
  it("round-trips a secret", () => {
    const ct = encryptSecret("super-secret-token");
    expect(decryptSecret(ct)).toBe("super-secret-token");
  });

  it("produces the v1:<iv>:<tag>:<ct> envelope format with base64 parts", () => {
    const ct = encryptSecret("x");
    expect(ct.startsWith("v1:")).toBe(true);
    const [iv, tag, body] = ct.slice(3).split(":");
    expect(Buffer.from(iv, "base64")).toHaveLength(12); // 96-bit GCM nonce
    expect(Buffer.from(tag, "base64")).toHaveLength(16); // 128-bit auth tag
    expect(body.length).toBeGreaterThan(0);
  });

  it("uses a random IV per encryption (same plaintext → different ciphertext)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("round-trips unicode secrets", () => {
    const s = "tøken—✓—كنية—🔑";
    expect(decryptSecret(encryptSecret(s))).toBe(s);
  });

  it("round-trips long secrets (4 KiB)", () => {
    const s = "k".repeat(4096) + "-tail";
    expect(decryptSecret(encryptSecret(s))).toBe(s);
  });

  it("round-trips an empty string", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });
});

// ─── Legacy plaintext passthrough ────────────────────────────────────────────

describe("decryptSecret legacy passthrough", () => {
  it("returns legacy plaintext as-is (never throws)", () => {
    expect(decryptSecret("plain-legacy-token")).toBe("plain-legacy-token");
  });

  it("returns an empty string as-is", () => {
    expect(decryptSecret("")).toBe("");
  });

  it("passes through values that merely contain a colon", () => {
    expect(decryptSecret("keycloak::{\"a\":1}")).toBe("keycloak::{\"a\":1}");
  });
});

// ─── isEncrypted ─────────────────────────────────────────────────────────────

describe("isEncrypted", () => {
  it("is true for v1: envelope values", () => {
    expect(isEncrypted(encryptSecret("x"))).toBe(true);
  });

  it("is false for plaintext values", () => {
    expect(isEncrypted("plain")).toBe(false);
    expect(isEncrypted("v2:something")).toBe(false);
  });
});

// ─── Tamper detection (fail closed) ─────────────────────────────────────────

describe("tamper detection", () => {
  function tamper(ct: string, part: 0 | 1 | 2): string {
    const parts = ct.slice(3).split(":");
    const target = parts[part];
    const flipped = (target.startsWith("A") ? "B" : "A") + target.slice(1);
    parts[part] = flipped;
    return `v1:${parts.join(":")}`;
  }

  it("throws when a ciphertext byte is flipped", () => {
    expect(() => decryptSecret(tamper(encryptSecret("s3cret"), 2))).toThrow();
  });

  it("throws when the auth tag is tampered with", () => {
    expect(() => decryptSecret(tamper(encryptSecret("s3cret"), 1))).toThrow();
  });

  it("throws when the IV is tampered with", () => {
    expect(() => decryptSecret(tamper(encryptSecret("s3cret"), 0))).toThrow();
  });

  it("throws on a malformed v1: value (missing parts)", () => {
    expect(() => decryptSecret("v1:onlytwo:parts")).toThrow(/malformed/);
    expect(() => decryptSecret("v1:")).toThrow(/malformed/);
  });

  it("never returns partial plaintext on auth failure", () => {
    const ct = tamper(encryptSecret("s3cret"), 2);
    let leaked: string | null = null;
    try {
      leaked = decryptSecret(ct);
    } catch {
      /* expected */
    }
    expect(leaked).toBeNull();
  });
});

// ─── Wrong key ───────────────────────────────────────────────────────────────

describe("wrong master key", () => {
  afterEach(() => {
    vi.stubEnv("SECRETS_MASTER_KEY", TEST_KEY_B64);
    vi.resetModules();
  });

  it("fails closed (throws) when decrypting with a different key", async () => {
    const ct = encryptSecret("s3cret");
    vi.stubEnv("SECRETS_MASTER_KEY", OTHER_KEY_B64);
    vi.resetModules();
    const fresh = await import("./services/crypto/secrets");
    expect(() => fresh.decryptSecret(ct)).toThrow();
  });

  it("round-trips under the injected env key after module reload", async () => {
    vi.stubEnv("SECRETS_MASTER_KEY", OTHER_KEY_B64);
    vi.resetModules();
    const fresh = await import("./services/crypto/secrets");
    const ct = fresh.encryptSecret("under-other-key");
    expect(fresh.decryptSecret(ct)).toBe("under-other-key");
    // ... and the original key cannot read it.
    expect(() => decryptSecret(ct)).toThrow();
  });
});

// ─── reencryptIfPlain ────────────────────────────────────────────────────────

describe("reencryptIfPlain", () => {
  it("encrypts plaintext and the result decrypts to the original", () => {
    const out = reencryptIfPlain("plain-token");
    expect(isEncrypted(out as string)).toBe(true);
    expect(decryptSecret(out as string)).toBe("plain-token");
  });

  it("is idempotent — already-encrypted values pass through unchanged", () => {
    const ct = encryptSecret("token");
    expect(reencryptIfPlain(ct)).toBe(ct);
  });

  it("passes null through", () => {
    expect(reencryptIfPlain(null)).toBeNull();
  });

  it("passes undefined through", () => {
    expect(reencryptIfPlain(undefined)).toBeUndefined();
  });
});

// ─── Dev/test fallback key ───────────────────────────────────────────────────

describe("dev/test fallback key", () => {
  afterEach(() => {
    vi.stubEnv("SECRETS_MASTER_KEY", TEST_KEY_B64);
    vi.resetModules();
  });

  it("derives a deterministic dev key and warns loudly exactly once", async () => {
    vi.stubEnv("SECRETS_MASTER_KEY", "");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fresh = await import("./services/crypto/secrets");
      const ct = fresh.encryptSecret("dev-secret");
      expect(fresh.decryptSecret(ct)).toBe("dev-secret");
      fresh.encryptSecret("again");
      const devWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("DEV-ONLY"));
      expect(devWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── No-secret-in-logs guard ─────────────────────────────────────────────────

describe("no-secret-in-logs guard", () => {
  it("failure paths never log the plaintext or ciphertext", async () => {
    const plaintext = "s3cr3t-value-must-not-leak";
    const ct = encryptSecret(plaintext);
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    try {
      // Tampered ciphertext → throws.
      const tampered = `v1:${ct.slice(3).split(":").map((p, i) => (i === 2 ? p.slice(0, -2) + "AA" : p)).join(":")}`;
      expect(() => decryptSecret(tampered)).toThrow();
      // Wrong key → throws.
      vi.stubEnv("SECRETS_MASTER_KEY", OTHER_KEY_B64);
      vi.resetModules();
      const fresh = await import("./services/crypto/secrets");
      expect(() => fresh.decryptSecret(ct)).toThrow();
      // Malformed → throws.
      expect(() => fresh.decryptSecret("v1:bad")).toThrow();
    } finally {
      for (const s of spies) s.mockRestore();
      vi.stubEnv("SECRETS_MASTER_KEY", TEST_KEY_B64);
      vi.resetModules();
    }
    const all = logs.join("\n");
    expect(all).not.toContain(plaintext);
    expect(all).not.toContain(ct);
  });
});

// ─── Production env boot gate ────────────────────────────────────────────────

describe("SECRETS_MASTER_KEY production boot gate", () => {
  const BOOT_VARS = [
    "DATABASE_URL", "POSTGRES_URL", "JWT_SECRET", "KEYCLOAK_URL",
    "APP_URL", "REDIS_URL", "REDIS_TLS_URL", "SECRETS_MASTER_KEY",
    "KYC_SERVICE_API_KEY", "KYC_INTERNAL_API_KEY", "INTERNAL_API_KEY",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(BOOT_VARS.concat("NODE_ENV").map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    vi.stubEnv("SECRETS_MASTER_KEY", TEST_KEY_B64);
  });

  function setProdBaseline() {
    process.env.NODE_ENV = ""; // production semantics
    process.env.DATABASE_URL = "postgres://x";
    process.env.JWT_SECRET = "a-strong-secret";
    process.env.KEYCLOAK_URL = "https://kc.example";
    process.env.APP_URL = "https://app.example";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.KYC_SERVICE_API_KEY = "kyc-live-test-key";
    process.env.INTERNAL_API_KEY = "internal-test-key"; // W30: REQUIRED_BY_ENV
    process.env.WHATSAPP_VERIFY_TOKEN = "wa-verify-test-token-0123456789"; // A4-04 prod boot gate
    process.env.USSD_GATEWAY_SECRET = "ussd-test-secret"; // W30 merge: D's /ussd prod boot gate
  }

  it("refuses to boot in production without SECRETS_MASTER_KEY", async () => {
    setProdBaseline();
    delete process.env.SECRETS_MASTER_KEY;
    vi.resetModules();
    await expect(import("./_core/env")).rejects.toThrow(/SECRETS_MASTER_KEY/);
  });

  it("refuses to boot in production with a malformed SECRETS_MASTER_KEY", async () => {
    setProdBaseline();
    process.env.SECRETS_MASTER_KEY = "not-base64-32-bytes!!";
    vi.resetModules();
    await expect(import("./_core/env")).rejects.toThrow(/SECRETS_MASTER_KEY is not a valid/);
  });

  it("boots in production with a valid base64 32-byte key", async () => {
    setProdBaseline();
    process.env.SECRETS_MASTER_KEY = TEST_KEY_B64;
    vi.resetModules();
    const mod = await import("./_core/env");
    expect(mod.REQUIRED_BY_ENV.SECRETS_MASTER_KEY).toBe(TEST_KEY_B64);
  });

  it("dev/test boots without the key (warn-only, fail-open)", async () => {
    for (const k of BOOT_VARS) delete process.env[k];
    process.env.NODE_ENV = "test";
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("./_core/env");
      expect(mod.ENV).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});
