/**
 * W42 (PLT-14) — TLS client policy: verify by default, CA bundle override,
 * honest misconfig errors, explicit dev opt-out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildTlsOptions } from "./tlsConfig";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["REDIS_TLS_CA", "REDIS_TLS_REJECT_UNAUTHORIZED"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildTlsOptions", () => {
  it("defaults to rejectUnauthorized=true with no CA", () => {
    delete process.env.REDIS_TLS_CA;
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    expect(buildTlsOptions("Redis", "REDIS")).toEqual({ rejectUnauthorized: true, ca: undefined });
  });

  it("honors an inline PEM CA bundle", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    process.env.REDIS_TLS_CA = pem;
    expect(buildTlsOptions("Redis", "REDIS")).toEqual({ rejectUnauthorized: true, ca: pem });
  });

  it("throws an honest error for a missing CA path", () => {
    process.env.REDIS_TLS_CA = "/nonexistent/ca.crt";
    expect(() => buildTlsOptions("Redis", "REDIS")).toThrow(/REDIS_TLS_CA.*refusing to connect/s);
  });

  it("throws for a CA value that is neither PEM nor file", () => {
    process.env.REDIS_TLS_CA = "garbage";
    expect(() => buildTlsOptions("Redis", "REDIS")).toThrow(/refusing to connect/);
  });

  it("explicit opt-out disables verification", () => {
    delete process.env.REDIS_TLS_CA;
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
    expect(buildTlsOptions("Redis", "REDIS").rejectUnauthorized).toBe(false);
  });
});
