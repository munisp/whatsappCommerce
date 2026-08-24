/**
 * env.ts production boot-gate tests (w12).
 *
 * env.ts evaluates fail-closed checks at IMPORT time, so each case resets
 * the module registry and dynamically re-imports with a controlled
 * process.env. Cases:
 *   - prod + VLM_MOCK_MODE=true            → FATAL
 *   - prod + KYC_SERVICE_API_KEY unset     → FATAL (missing required)
 *   - prod + KYC_SERVICE_API_KEY=dev-kyc-key → FATAL (known insecure default)
 *   - prod + valid KYC key, no mock mode   → boots
 *   - test env + mock mode + dev key       → allowed (warn only)
 */
import { describe, it, expect, afterEach } from "vitest";

const VALID_MASTER_KEY = Buffer.from("a".repeat(32)).toString("base64");

function prodEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x:x@db:5432/x",
    JWT_SECRET: "super-strong-jwt-secret-0123456789",
    KEYCLOAK_URL: "https://keycloak.example.com",
    APP_URL: "https://app.example.com",
    REDIS_URL: "redis://redis:6379",
    SECRETS_MASTER_KEY: VALID_MASTER_KEY,
    KYC_SERVICE_API_KEY: "kyc-live-key-0123456789abcdef",
    INTERNAL_API_KEY: "internal-test-key", // W30: REQUIRED_BY_ENV
    // A4-04: prod boot gate requires a non-default WhatsApp verify token.
    WHATSAPP_VERIFY_TOKEN: "wa-verify-test-token-0123456789",
    USSD_GATEWAY_SECRET: "ussd-test-secret", // W30 merge: D's /ussd prod boot gate
    VLM_MOCK_MODE: undefined,
    KYC_INTERNAL_API_KEY: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function importFreshEnv(): Promise<unknown> {
  const { vi } = await import("vitest");
  vi.resetModules();
  return import("./env");
}

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe("env production boot gates (KYC pipeline fail-closed)", () => {
  it("prod + VLM_MOCK_MODE=true → FATAL at import", async () => {
    prodEnv({ VLM_MOCK_MODE: "true" });
    await expect(importFreshEnv()).rejects.toThrow(/VLM_MOCK_MODE/);
  });

  it("prod + VLM_MOCK_MODE=TRUE (any case) → FATAL", async () => {
    prodEnv({ VLM_MOCK_MODE: "TRUE" });
    await expect(importFreshEnv()).rejects.toThrow(/VLM_MOCK_MODE/);
  });

  it("prod + KYC_SERVICE_API_KEY unset → FATAL (missing required)", async () => {
    prodEnv({ KYC_SERVICE_API_KEY: undefined, KYC_INTERNAL_API_KEY: undefined });
    await expect(importFreshEnv()).rejects.toThrow(/KYC_SERVICE_API_KEY/);
  });

  it('prod + KYC_SERVICE_API_KEY="dev-kyc-key" → FATAL (known insecure default)', async () => {
    prodEnv({ KYC_SERVICE_API_KEY: "dev-kyc-key" });
    await expect(importFreshEnv()).rejects.toThrow(/dev-kyc-key/);
  });

  it("prod + KYC_INTERNAL_API_KEY alias satisfies the requirement", async () => {
    prodEnv({ KYC_SERVICE_API_KEY: undefined, KYC_INTERNAL_API_KEY: "kyc-live-alias-key-123" });
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });

  it("prod + valid KYC key + mock mode off → boots", async () => {
    prodEnv({ VLM_MOCK_MODE: "false" });
    const mod: any = await importFreshEnv();
    expect(mod.ENV.isProd).toBe(true);
    expect(mod.REQUIRED_BY_ENV.KYC_SERVICE_API_KEY).toBe("kyc-live-key-0123456789abcdef");
  });

  it("test env + mock mode + dev key → allowed (warn only)", async () => {
    prodEnv({ NODE_ENV: "test", VLM_MOCK_MODE: "true", KYC_SERVICE_API_KEY: "dev-kyc-key" });
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });
});
