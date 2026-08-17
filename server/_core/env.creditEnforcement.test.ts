/**
 * W14 — isCreditEnforcementStrict() env posture.
 *
 * CREDIT_ENFORCEMENT_STRICT unset defaults to fail-CLOSED in production-like
 * environments (isProd) and fail-open in development/test; explicit
 * true/false overrides the default in either direction.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const PROD_BOOT_ENV: Record<string, string> = {
  NODE_ENV: "production",
  JWT_SECRET: "w14-test-secret-key-material-32bytes!",
  DATABASE_URL: "postgres://localhost:5432/test",
  KEYCLOAK_URL: "http://localhost:8080",
  APP_URL: "http://localhost:3000",
  REDIS_URL: "redis://localhost:6379",
  SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  KYC_SERVICE_API_KEY: "w14-test-kyc-key",
  // A4-04: prod boot gate requires a non-default WhatsApp verify token.
  WHATSAPP_VERIFY_TOKEN: "wa-verify-test-token-0123456789",
};

async function importFreshEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CREDIT_ENFORCEMENT_STRICT;
  delete process.env.VLM_MOCK_MODE;
  delete process.env.PERMIFY_URL;
  delete process.env.REQUIRE_PERMIFY;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("./env");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("isCreditEnforcementStrict", () => {
  it("defaults to STRICT (fail-closed) in production-like envs", async () => {
    const env = await importFreshEnv({ ...PROD_BOOT_ENV });
    expect(env.isProd).toBe(true);
    expect(env.isCreditEnforcementStrict()).toBe(true);
  });

  it("honors explicit CREDIT_ENFORCEMENT_STRICT=false in production", async () => {
    const env = await importFreshEnv({ ...PROD_BOOT_ENV, CREDIT_ENFORCEMENT_STRICT: "false" });
    expect(env.isCreditEnforcementStrict()).toBe(false);
  });

  it("defaults to non-strict (fail-open) in development/test", async () => {
    const env = await importFreshEnv({ NODE_ENV: "test" });
    expect(env.isProd).toBe(false);
    expect(env.isCreditEnforcementStrict()).toBe(false);
  });

  it("honors explicit CREDIT_ENFORCEMENT_STRICT=true outside production", async () => {
    const env = await importFreshEnv({ NODE_ENV: "test", CREDIT_ENFORCEMENT_STRICT: "true" });
    expect(env.isCreditEnforcementStrict()).toBe(true);
  });

  it("reads the flag lazily (runtime toggle takes effect without reload)", async () => {
    const env = await importFreshEnv({ NODE_ENV: "test" });
    expect(env.isCreditEnforcementStrict()).toBe(false);
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    expect(env.isCreditEnforcementStrict()).toBe(true);
  });
});
