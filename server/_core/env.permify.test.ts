/**
 * W12.1 — env.ts REQUIRE_PERMIFY production gate.
 *
 * adminProcedure layers Permify on top of the role check ONLY when
 * PERMIFY_URL is set. Deployments that require that defense-in-depth layer
 * set REQUIRE_PERMIFY=true; the process must then REFUSE to boot in
 * production-like environments when PERMIFY_URL is unset, instead of
 * silently running with Permify disabled. Outside production it is a
 * warning only. env.ts evaluates at import time, so each case resets the
 * module registry and re-imports with a controlled process.env.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const VALID_MASTER_KEY = Buffer.from("a".repeat(32)).toString("base64");

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
    REQUIRE_PERMIFY: undefined,
    PERMIFY_URL: undefined,
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

describe("env REQUIRE_PERMIFY gate (W12.1)", () => {
  it("prod + REQUIRE_PERMIFY=true + PERMIFY_URL unset → FATAL at import", async () => {
    setEnv({ REQUIRE_PERMIFY: "true" });
    await expect(importFreshEnv()).rejects.toThrow(/REQUIRE_PERMIFY/);
  });

  it("prod + REQUIRE_PERMIFY=true + PERMIFY_URL set → boots", async () => {
    setEnv({ REQUIRE_PERMIFY: "true", PERMIFY_URL: "http://permify:3476" });
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });

  it("test env + REQUIRE_PERMIFY=true + PERMIFY_URL unset → warns and boots", async () => {
    setEnv({ NODE_ENV: "test", REQUIRE_PERMIFY: "true" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importFreshEnv()).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REQUIRE_PERMIFY"));
  });

  it("prod + REQUIRE_PERMIFY unset → boots without PERMIFY_URL (gate is opt-in)", async () => {
    setEnv();
    await expect(importFreshEnv()).resolves.toBeTruthy();
  });
});
