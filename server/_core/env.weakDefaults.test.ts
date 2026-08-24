/**
 * env.ts weak-default boot gates (assurance A4-04 / A4-05 / A4-12).
 *
 * env.ts evaluates fail-closed checks at IMPORT time, so each case resets
 * the module registry and re-imports with a controlled process.env:
 *   - prod + WHATSAPP_VERIFY_TOKEN unset            → FATAL (A4-04)
 *   - prod + WHATSAPP_VERIFY_TOKEN = public demo    → FATAL (A4-04)
 *   - prod + APISIX_ADMIN_KEY = vendor default      → WARN, boots (A4-05) —
 *     the admin endpoint is ClusterIP-only (needs cluster-network access to
 *     exploit) and the key is shared across other services/namespaces, so a
 *     single app boot shouldn't be able to block on it; see env.ts A4-05.
 *   - prod + APISIX configured + key unset          → FATAL (A4-05)
 *   - prod + OpenSearch/MinIO compose defaults      → WARN, boots (A4-12)
 *   - prod + all strong values                      → boots
 *   - dev  + demo verify token + vendor apisix key  → allowed (unaffected)
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const VALID_MASTER_KEY = Buffer.from("a".repeat(32)).toString("base64");
const APISIX_VENDOR_DEFAULT_KEY = "edd1c9f034335f136f87ad84b625c8f1";

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x:x@db:5432/x",
    JWT_SECRET: "super-strong-jwt-secret-0123456789",
    KEYCLOAK_URL: "https://keycloak.example.com",
    APP_URL: "https://app.example.com",
    REDIS_URL: "redis://redis:6379",
    SECRETS_MASTER_KEY: VALID_MASTER_KEY,
    KYC_SERVICE_API_KEY: "kyc-live-key-0123456789abcdef",
    VLM_MOCK_MODE: undefined,
    WHATSAPP_VERIFY_TOKEN: "wa-verify-strong-unique-token",
    USSD_GATEWAY_SECRET: "ussd-test-secret", // W30 merge: D's /ussd prod boot gate
    INTERNAL_API_KEY: "internal-test-key", // W30 merge: E's REQUIRED_BY_ENV
    APISIX_ADMIN_URL: undefined,
    APISIX_ADMIN_KEY: undefined,
    OPENSEARCH_PASS: "opensearch-strong-pass",
    S3_ACCESS_KEY: "s3-unique-access",
    S3_SECRET_KEY: "s3-unique-secret",
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function importFreshEnv(): Promise<unknown> {
  vi.resetModules();
  return import("./env");
}

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe("env weak-default boot gates (A4-04/A4-05/A4-12)", () => {
  it("prod + WHATSAPP_VERIFY_TOKEN unset → FATAL", async () => {
    setEnv({ WHATSAPP_VERIFY_TOKEN: undefined });
    await expect(importFreshEnv()).rejects.toThrow(/WHATSAPP_VERIFY_TOKEN/);
  });

  it("prod + WHATSAPP_VERIFY_TOKEN = public demo string → FATAL", async () => {
    setEnv({ WHATSAPP_VERIFY_TOKEN: "whatsapp_verify_token_demo" });
    await expect(importFreshEnv()).rejects.toThrow(/WHATSAPP_VERIFY_TOKEN/);
  });

  it("prod + APISIX_ADMIN_KEY = published vendor default → warns but boots", async () => {
    setEnv({ APISIX_ADMIN_KEY: APISIX_VENDOR_DEFAULT_KEY });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importFreshEnv()).resolves.toBeTruthy();
    const messages = warn.mock.calls.flat().join(" ");
    expect(messages).toMatch(/APISIX_ADMIN_KEY/);
    expect(messages).toMatch(/vendor-default/);
  });

  it("prod + APISIX configured (URL set) but key unset → FATAL", async () => {
    setEnv({ APISIX_ADMIN_URL: "http://apisix:9180", APISIX_ADMIN_KEY: undefined });
    await expect(importFreshEnv()).rejects.toThrow(/APISIX_ADMIN_KEY/);
  });

  it("prod + APISIX not configured at all → boots (gate is conditional)", async () => {
    setEnv({ APISIX_ADMIN_URL: undefined, APISIX_ADMIN_KEY: undefined });
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });

  it("prod + OpenSearch/MinIO compose defaults → warns but boots (A4-12)", async () => {
    setEnv({
      OPENSEARCH_PASS: "admin",
      S3_ACCESS_KEY: "minioadmin",
      S3_SECRET_KEY: "minioadmin",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importFreshEnv()).resolves.toBeTruthy();
    const messages = warn.mock.calls.flat().join(" ");
    expect(messages).toMatch(/OPENSEARCH_PASS/);
    expect(messages).toMatch(/S3_ACCESS_KEY/);
  });

  it("prod + all strong values → boots without weak-default warnings", async () => {
    setEnv({ APISIX_ADMIN_URL: "http://apisix:9180", APISIX_ADMIN_KEY: "strong-apisix-key-0123" });
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });

  it("dev + demo verify token + vendor apisix key → unaffected (boots)", async () => {
    setEnv({
      NODE_ENV: "development",
      WHATSAPP_VERIFY_TOKEN: "whatsapp_verify_token_demo",
      APISIX_ADMIN_KEY: APISIX_VENDOR_DEFAULT_KEY,
      OPENSEARCH_PASS: "admin",
      S3_ACCESS_KEY: "minioadmin",
      S3_SECRET_KEY: "minioadmin",
    });
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });
});
